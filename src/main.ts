import { Notice, Plugin } from "obsidian";
import { AccountSettings, migrateSettings, PluginSettings } from "./types";
import { GmailClient } from "./gmail";
import { NoteWriter } from "./notes";
import { SyncEngine, SyncProgress } from "./sync";
import { GmailMailboxSettingTab } from "./settings";
import { UpcomingView, VIEW_TYPE_UPCOMING } from "./views/upcoming";
import { setDebug, log, logError } from "./log";

/** Per-account wiring: one client, note writer, and sync engine per account. */
export interface AccountContext {
	account: AccountSettings;
	gmail: GmailClient;
	notes: NoteWriter;
	sync: SyncEngine;
}

export default class GmailMailboxPlugin extends Plugin {
	settings!: PluginSettings;
	contexts: AccountContext[] = [];

	private syncing = false;
	/** Set by stopSync so a stop between two accounts' runs also halts the loop. */
	private stopAll = false;
	private statusEl: HTMLElement | null = null;
	private timer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyDebug();
		this.rebuildContexts();

		this.addSettingTab(new GmailMailboxSettingTab(this.app, this));

		this.registerView(VIEW_TYPE_UPCOMING, (leaf) => new UpcomingView(leaf, this));

		this.addRibbonIcon("mail", "Sync Gmail mailbox", () => this.runSync());
		this.addRibbonIcon("calendar-clock", "Gmail: upcoming meetings", () =>
			this.activateUpcomingView(),
		);

		this.addCommand({
			id: "gmail-sync-now",
			name: "Sync now",
			callback: () => this.runSync(),
		});
		this.addCommand({
			id: "gmail-stop-sync",
			name: "Stop sync",
			checkCallback: (checking) => {
				if (!this.isSyncing) return false;
				if (!checking) this.stopSync();
				return true;
			},
		});
		this.addCommand({
			id: "gmail-connect",
			name: "Connect account",
			callback: () => {
				// Connect the first account that still lacks a token; manage the
				// rest from the settings tab.
				const ctx = this.contexts.find((c) => !c.gmail.isAuthenticated) ?? this.contexts[0];
				if (!ctx) return;
				this.connect(ctx.account).catch(
					(e) => new Notice(`Connect failed: ${(e as Error).message}`),
				);
			},
		});
		this.addCommand({
			id: "gmail-open-upcoming",
			name: "Open upcoming meetings",
			callback: () => this.activateUpcomingView(),
		});

		this.statusEl = this.addStatusBarItem();
		this.updateStatus(this.lastSyncIso() ? "idle" : "not-synced");

		this.rescheduleTimer();

		if (this.settings.syncOnStartup && this.contexts.some((c) => c.gmail.isAuthenticated)) {
			this.app.workspace.onLayoutReady(() => {
				window.setTimeout(() => this.runSync(true), 3000);
			});
		}

		log("Plugin loaded.");
	}

	onunload(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
	}

	get isSyncing(): boolean {
		return this.syncing || this.contexts.some((c) => c.sync.isRunning);
	}

	/**
	 * Rebuilds the per-account wiring from `settings.accounts`. Call after adding
	 * or removing an account. The settings UI disables account mutations while a
	 * sync runs, so this never swaps an engine mid-flight.
	 */
	rebuildContexts(): void {
		this.contexts = this.settings.accounts.map((account) => {
			const gmail = new GmailClient(
				this.settings,
				account,
				(url) => window.open(url, "_blank"),
				async () => {
					await this.saveSettings();
				},
			);
			const notes = new NoteWriter(this.app, account);
			const sync = new SyncEngine(
				this.settings,
				account,
				gmail,
				notes,
				() => this.saveSettings(),
				(p) => this.onSyncProgress(account, p),
			);
			return { account, gmail, notes, sync };
		});
	}

	contextFor(account: AccountSettings): AccountContext | undefined {
		return this.contexts.find((c) => c.account.id === account.id);
	}

	async connect(account: AccountSettings): Promise<void> {
		const ctx = this.contextFor(account);
		if (!ctx) throw new Error("Unknown account.");
		await ctx.gmail.login();
		try {
			const me = await ctx.gmail.profile();
			account.emailAddress = me.emailAddress || null;
		} catch {
			account.emailAddress = null;
		}
		await this.saveSettings();
		this.updateStatus("idle");
	}

	/** Syncs every connected account in turn, then shows one merged summary. */
	async runSync(silent = false): Promise<void> {
		const ready = this.contexts.filter((c) => c.gmail.isAuthenticated);
		if (!ready.length) {
			if (!silent) new Notice("Gmail Mailbox: no account connected. Open settings to connect.");
			return;
		}
		if (this.isSyncing) {
			if (!silent) new Notice("Gmail Mailbox: a sync is already running.");
			return;
		}
		this.syncing = true;
		this.stopAll = false;
		this.updateStatus("syncing");
		const totals = { added: 0, updated: 0, removed: 0, labels: 0, accounts: 0, cancelled: false };
		const errors: string[] = [];
		try {
			for (const ctx of ready) {
				if (this.stopAll) {
					totals.cancelled = true;
					break;
				}
				try {
					const report = await ctx.sync.syncAll();
					totals.added += report.added;
					totals.updated += report.updated;
					totals.removed += report.removed;
					totals.labels += report.labels;
					totals.accounts++;
					errors.push(...report.errors.map((e) => `${ctx.account.displayName}: ${e}`));
					if (report.cancelled) {
						// The user stopped the run; skip the remaining accounts too.
						totals.cancelled = true;
						break;
					}
				} catch (e) {
					logError(`Sync failed (${ctx.account.displayName}):`, e);
					errors.push(`${ctx.account.displayName}: ${(e as Error).message}`);
				}
			}
			this.updateStatus(totals.accounts === 0 && errors.length ? "error" : "idle");
			const across =
				`${totals.labels} label(s)` +
				(ready.length > 1 ? ` in ${totals.accounts} account(s)` : "");
			const summary =
				`${totals.cancelled ? "Gmail (stopped): +" : "Gmail: +"}${totals.added} new, ` +
				`${totals.updated} updated, ${totals.removed} removed across ${across}.`;
			if (totals.cancelled || !silent || totals.added || totals.updated || totals.removed) {
				new Notice(summary);
			}
			if (errors.length) {
				new Notice(`Gmail: ${errors.length} error(s). See console.`);
				errors.forEach((e) => logError(e));
			}
			this.refreshUpcomingView();
		} finally {
			this.syncing = false;
		}
	}

	/** Cooperatively stops an in-flight sync. Safe to call when idle. */
	stopSync(): void {
		if (!this.isSyncing) {
			new Notice("Gmail Mailbox: no sync is running.");
			return;
		}
		this.stopAll = true;
		for (const ctx of this.contexts) ctx.sync.requestCancel();
		new Notice("Gmail Mailbox: stopping sync…");
		this.updateStatus("stopping");
	}

	/** Opens (or reveals) the Upcoming meetings sidebar view. */
	async activateUpcomingView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_UPCOMING)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_UPCOMING, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	/** Re-renders any open Upcoming views from the refreshed caches. */
	refreshUpcomingView(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_UPCOMING)) {
			const view = leaf.view;
			if (view instanceof UpcomingView) view.render();
		}
	}

	rescheduleTimer(): void {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
		const mins = this.settings.syncIntervalMinutes;
		if (mins > 0) {
			this.timer = window.setInterval(() => this.runSync(true), mins * 60 * 1000);
			this.registerInterval(this.timer);
			log(`Auto-sync scheduled every ${mins} min.`);
		}
	}

	applyDebug(): void {
		setDebug(this.settings.debugLogging);
	}

	/** Most recent successful sync across all accounts, for the status bar. */
	lastSyncIso(): string | null {
		let latest: string | null = null;
		for (const a of this.settings.accounts) {
			if (a.lastSync && (!latest || a.lastSync > latest)) latest = a.lastSync;
		}
		return latest;
	}

	private onSyncProgress(account: AccountSettings, p: SyncProgress): void {
		if (!this.statusEl) return;
		const count = p.total != null ? `${p.processed}/${p.total}` : `${p.processed}`;
		const verb = p.phase === "listing" ? "listing" : "writing";
		const label =
			this.settings.accounts.length > 1 ? `${account.displayName} · ${p.label}` : p.label;
		this.statusEl.setText(`✉️ ${label}: ${verb} ${count}…`);
	}

	private updateStatus(state: "idle" | "syncing" | "stopping" | "error" | "not-synced"): void {
		if (!this.statusEl) return;
		const lastIso = this.lastSyncIso();
		const last = lastIso
			? new Date(lastIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: "never";
		const label: Record<typeof state, string> = {
			idle: `✉️ Gmail · ${last}`,
			syncing: "✉️ Gmail · syncing…",
			stopping: "✉️ Gmail · stopping…",
			error: "✉️ Gmail · error",
			"not-synced": "✉️ Gmail · not synced",
		};
		this.statusEl.setText(label[state]);
		this.statusEl.title = "Click the ribbon mail icon to sync";
	}

	async loadSettings(): Promise<void> {
		// migrateSettings also lifts pre-multi-account data into accounts[0].
		this.settings = migrateSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
