import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings } from "./types";
import { GmailClient } from "./gmail";
import { NoteWriter } from "./notes";
import { SyncEngine, SyncProgress } from "./sync";
import { GmailMailboxSettingTab } from "./settings";
import { UpcomingView, VIEW_TYPE_UPCOMING } from "./views/upcoming";
import { setDebug, log, logError } from "./log";

export default class GmailMailboxPlugin extends Plugin {
	settings!: PluginSettings;
	gmail!: GmailClient;
	notes!: NoteWriter;
	sync!: SyncEngine;
	connectedAs: string | null = null;

	private statusEl: HTMLElement | null = null;
	private timer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyDebug();

		this.gmail = new GmailClient(
			this.settings,
			(url) => window.open(url, "_blank"),
			async (refreshToken) => {
				this.settings.refreshToken = refreshToken;
				await this.saveSettings();
			},
		);
		this.notes = new NoteWriter(this.app, this.settings);
		this.sync = new SyncEngine(
			this.settings,
			this.gmail,
			this.notes,
			() => this.saveSettings(),
			(p) => this.onSyncProgress(p),
		);

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
				if (!this.sync.isRunning) return false;
				if (!checking) this.stopSync();
				return true;
			},
		});
		this.addCommand({
			id: "gmail-connect",
			name: "Connect account",
			callback: () => this.connect().catch((e) => new Notice(`Connect failed: ${e.message}`)),
		});
		this.addCommand({
			id: "gmail-open-upcoming",
			name: "Open upcoming meetings",
			callback: () => this.activateUpcomingView(),
		});

		this.statusEl = this.addStatusBarItem();
		this.updateStatus(this.settings.lastSync ? "idle" : "not-synced");

		this.rescheduleTimer();

		if (this.settings.syncOnStartup && this.gmail.isAuthenticated) {
			this.app.workspace.onLayoutReady(() => {
				window.setTimeout(() => this.runSync(true), 3000);
			});
		}

		log("Plugin loaded.");
	}

	onunload(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
	}

	async connect(): Promise<void> {
		await this.gmail.login();
		try {
			const me = await this.gmail.profile();
			this.connectedAs = me.emailAddress || null;
		} catch {
			this.connectedAs = null;
		}
		this.updateStatus("idle");
	}

	async runSync(silent = false): Promise<void> {
		if (!this.gmail.isAuthenticated) {
			if (!silent) new Notice("Gmail Mailbox: not connected. Open settings to connect.");
			return;
		}
		if (this.sync.isRunning) {
			if (!silent) new Notice("Gmail Mailbox: a sync is already running.");
			return;
		}
		this.updateStatus("syncing");
		try {
			const report = await this.sync.syncAll();
			this.updateStatus("idle");
			const summary =
				`${report.cancelled ? "Gmail (stopped): +" : "Gmail: +"}${report.added} new, ` +
				`${report.updated} updated, ${report.removed} removed across ` +
				`${report.labels} label(s).`;
			if (report.cancelled || !silent || report.added || report.updated || report.removed) {
				new Notice(summary);
			}
			if (report.errors.length) {
				new Notice(`Gmail: ${report.errors.length} error(s). See console.`);
				report.errors.forEach((e) => logError(e));
			}
			this.refreshUpcomingView();
		} catch (e) {
			this.updateStatus("error");
			logError("Sync failed:", e);
			if (!silent) new Notice(`Gmail sync failed: ${(e as Error).message}`);
		}
	}

	/** Cooperatively stops an in-flight sync. Safe to call when idle. */
	stopSync(): void {
		if (!this.sync.isRunning) {
			new Notice("Gmail Mailbox: no sync is running.");
			return;
		}
		this.sync.requestCancel();
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
		workspace.revealLeaf(leaf);
	}

	/** Re-renders any open Upcoming views from the refreshed cache. */
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

	private onSyncProgress(p: SyncProgress): void {
		if (!this.statusEl) return;
		const count = p.total != null ? `${p.processed}/${p.total}` : `${p.processed}`;
		const verb = p.phase === "listing" ? "listing" : "writing";
		this.statusEl.setText(`✉️ ${p.label}: ${verb} ${count}…`);
	}

	private updateStatus(state: "idle" | "syncing" | "stopping" | "error" | "not-synced"): void {
		if (!this.statusEl) return;
		const last = this.settings.lastSync
			? new Date(this.settings.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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
		const data = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.historyIds = this.settings.historyIds ?? {};
		this.settings.threads = this.settings.threads ?? {};
		this.settings.calendarNotes = this.settings.calendarNotes ?? {};
		this.settings.upcomingCache = this.settings.upcomingCache ?? [];
		this.settings.labels = this.settings.labels?.length
			? this.settings.labels
			: DEFAULT_SETTINGS.labels.map((f) => ({ ...f }));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
