import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type GmailMailboxPlugin from "./main";
import { AccountSettings, LabelMapping, normalizeAccount } from "./types";

export class GmailMailboxSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: GmailMailboxPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// --- Google OAuth client (shared by all accounts) ---
		new Setting(containerEl).setName("Google OAuth client").setHeading();
		containerEl.createEl("p", {
			text:
				"Create a Google Cloud OAuth client of type “Desktop app” (APIs & Services → Credentials), " +
				"enable the Gmail API and Google Calendar API, and add yourself as a test user on the OAuth consent screen. " +
				"Paste the Client ID and Client secret below. One client serves every account; each account " +
				"connects with its own consent. See README for the full walkthrough.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("From your Google Cloud OAuth 2.0 client (Desktop app).")
			.addText((t) =>
				t
					.setPlaceholder("xxxxx.apps.googleusercontent.com")
					.setValue(s.clientId)
					.onChange(async (v) => {
						s.clientId = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("The Desktop-app client secret. Required by Google's token endpoint even with PKCE.")
			.addText((t) => {
				t.setPlaceholder("GOCSPX-…")
					.setValue(s.clientSecret)
					.onChange(async (v) => {
						s.clientSecret = v.trim();
						await this.plugin.saveSettings();
					});
				t.inputEl.type = "password";
			});

		// --- Accounts ---
		s.accounts.forEach((account, idx) => this.renderAccount(containerEl, account, idx));

		new Setting(containerEl).addButton((b) =>
			b
				.setButtonText("Add account")
				.setIcon("plus")
				.setDisabled(this.plugin.isSyncing)
				.onClick(async () => {
					s.accounts.push(
						normalizeAccount({ displayName: `Account ${s.accounts.length + 1}` }),
					);
					this.plugin.rebuildContexts();
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		// --- Sync behaviour (shared) ---
		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("0 disables the timer. Sync manually via the ribbon icon or command.")
			.addText((t) =>
				t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
					const n = Math.max(0, Math.floor(Number(v) || 0));
					s.syncIntervalMinutes = n;
					await this.plugin.saveSettings();
					this.plugin.rescheduleTimer();
				}),
			);

		new Setting(containerEl).setName("Sync on startup").addToggle((t) =>
			t.setValue(s.syncOnStartup).onChange(async (v) => {
				s.syncOnStartup = v;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName("Download attachments")
			.setDesc("Save file attachments under each subfolder's _attachments directory.")
			.addToggle((t) =>
				t.setValue(s.downloadAttachments).onChange(async (v) => {
					s.downloadAttachments = v;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (s.downloadAttachments) {
			new Setting(containerEl)
				.setName("Max attachment size (MB)")
				.setDesc("0 = no limit.")
				.addText((t) =>
					t.setValue(String(s.maxAttachmentMB)).onChange(async (v) => {
						s.maxAttachmentMB = Math.max(0, Math.floor(Number(v) || 0));
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Verbose console output under the [obs-gmail] prefix.")
			.addToggle((t) =>
				t.setValue(s.debugLogging).onChange(async (v) => {
					s.debugLogging = v;
					await this.plugin.saveSettings();
					this.plugin.applyDebug();
				}),
			);

		// --- Maintenance ---
		new Setting(containerEl).setName("Maintenance").setHeading();
		new Setting(containerEl)
			.setName("Sync now")
			.setDesc(
				"Syncs every connected account. Stop halts the running sync at the next message/page; already-written notes are kept.",
			)
			.addButton((b) =>
				b
					.setButtonText("Sync now")
					.setCta()
					.setDisabled(this.plugin.isSyncing)
					.onClick(() => {
						// Fire without awaiting so the panel can re-render immediately
						// (enabling Stop); re-render again when the run settles.
						void this.plugin.runSync().finally(() => this.display());
						this.display();
					}),
			)
			.addButton((b) => {
				b.setButtonText("Stop")
					.setDisabled(!this.plugin.isSyncing)
					.onClick(() => {
						this.plugin.stopSync();
						this.display();
					});
				b.buttonEl.addClass("mod-warning");
			});

		new Setting(containerEl)
			.setName("Upcoming panel")
			.addButton((b) => b.setButtonText("Open sidebar").onClick(() => this.plugin.activateUpcomingView()));

		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc(
				"Clears history cursors and the thread index for every account so the next sync re-enumerates all messages. Existing notes are kept.",
			)
			.addButton((b) => {
				b.setButtonText("Reset").onClick(async () => {
					for (const ctx of this.plugin.contexts) ctx.sync.resetState();
					await this.plugin.saveSettings();
					new Notice("Sync state reset. Next sync will do a full enumeration.");
				});
				b.buttonEl.addClass("mod-warning");
			});
	}

	private renderAccount(containerEl: HTMLElement, account: AccountSettings, idx: number): void {
		const s = this.plugin.settings;
		const ctx = this.plugin.contextFor(account);

		new Setting(containerEl)
			.setName(account.displayName || `Account ${idx + 1}`)
			.setHeading()
			.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Remove account. Notes already in the vault are kept.")
					.setDisabled(this.plugin.isSyncing)
					.onClick(async () => {
						s.accounts.splice(idx, 1);
						// The UI (and sync loop) assume at least one account exists.
						if (!s.accounts.length) s.accounts.push(normalizeAccount({}));
						this.plugin.rebuildContexts();
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Account name")
			.setDesc("Shown in notices, sync logs, and the Upcoming sidebar.")
			.addText((t) =>
				t.setValue(account.displayName).onChange(async (v) => {
					account.displayName = v.trim() || `Account ${idx + 1}`;
					await this.plugin.saveSettings();
				}),
			);

		const connected = !!ctx?.gmail.isAuthenticated;
		const status = connected
			? `Connected${account.emailAddress ? ` as ${account.emailAddress}` : ""}` +
				(account.lastSync ? ` · last sync ${new Date(account.lastSync).toLocaleString()}` : "")
			: "Not connected";
		new Setting(containerEl)
			.setName("Connection status")
			.setDesc(status)
			.addButton((b) =>
				b
					.setButtonText(connected ? "Reconnect" : "Connect")
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						try {
							await this.plugin.connect(account);
							new Notice(`Connected to Google (${account.displayName}).`);
						} catch (e) {
							new Notice(`Connection failed: ${(e as Error).message}`);
						} finally {
							b.setDisabled(false);
							this.display();
						}
					}),
			)
			.addExtraButton((b) =>
				b
					.setIcon("log-out")
					.setTooltip("Disconnect")
					.onClick(async () => {
						await ctx?.gmail.logout();
						account.emailAddress = null;
						await this.plugin.saveSettings();
						new Notice(`Disconnected ${account.displayName}.`);
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Target folder")
			.setDesc("Root vault folder that this account's mail notes live under. Give each account its own folder.")
			.addText((t) =>
				t
					.setPlaceholder("10-Mailbox/Gmail")
					.setValue(account.targetFolder)
					.onChange(async (v) => {
						account.targetFolder = v.trim() || "10-Mailbox/Gmail";
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("p", {
			text: "Map Gmail labels to vault subfolders. Use a system label (INBOX, SENT, STARRED, IMPORTANT) or a user label's name like Projects/ClientX.",
			cls: "setting-item-description",
		});

		account.labels.forEach((mapping, li) => {
			this.renderLabelRow(containerEl, account, mapping, li);
		});

		new Setting(containerEl).addButton((b) =>
			b
				.setButtonText("Add label")
				.setIcon("plus")
				.onClick(async () => {
					account.labels.push({ gmailLabel: "", vaultSubfolder: "", enabled: true });
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		new Setting(containerEl)
			.setName("Sync mail newer than")
			.setDesc(
				"Only import mail received on/after this date (YYYY-MM-DD). Leave empty for all mail. Pushed to Gmail as an `after:` filter on the first sync.",
			)
			.addText((t) =>
				t
					.setPlaceholder("2025-01-01")
					.setValue(account.syncSince)
					.onChange(async (v) => {
						const val = v.trim();
						if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
							t.inputEl.addClass("gmail-mailbox-invalid");
							return;
						}
						t.inputEl.removeClass("gmail-mailbox-invalid");
						account.syncSince = val;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync calendar")
			.setDesc(
				"Fetch this account's upcoming events, write meeting notes, and show them in the Upcoming sidebar. " +
					"Requires the Google Calendar API and the calendar.readonly scope; if you enabled it after connecting, click Reconnect above to re-consent.",
			)
			.addToggle((t) =>
				t.setValue(account.syncCalendar).onChange(async (v) => {
					account.syncCalendar = v;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (account.syncCalendar) {
			new Setting(containerEl)
				.setName("Days ahead")
				.setDesc("Rolling window of upcoming days to keep.")
				.addText((t) =>
					t.setValue(String(account.calendarDaysAhead)).onChange(async (v) => {
						account.calendarDaysAhead = Math.max(1, Math.floor(Number(v) || 14));
						await this.plugin.saveSettings();
					}),
				);

			new Setting(containerEl)
				.setName("Calendar subfolder")
				.setDesc("Vault subfolder (under the target folder) for meeting notes.")
				.addText((t) =>
					t
						.setPlaceholder("Calendar")
						.setValue(account.calendarSubfolder)
						.onChange(async (v) => {
							account.calendarSubfolder = v.trim() || "Calendar";
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Link related emails")
				.setDesc("Cross-link meeting notes to email notes sharing attendees or subject.")
				.addToggle((t) =>
					t.setValue(account.linkRelatedEmails).onChange(async (v) => {
						account.linkRelatedEmails = v;
						await this.plugin.saveSettings();
					}),
				);
		}
	}

	private renderLabelRow(
		containerEl: HTMLElement,
		account: AccountSettings,
		mapping: LabelMapping,
		idx: number,
	): void {
		const row = new Setting(containerEl)
			.addText((t) =>
				t
					.setPlaceholder("Gmail label (e.g. INBOX)")
					.setValue(mapping.gmailLabel)
					.onChange(async (v) => {
						mapping.gmailLabel = v.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addText((t) =>
				t
					.setPlaceholder("Vault subfolder (e.g. Inbox)")
					.setValue(mapping.vaultSubfolder)
					.onChange(async (v) => {
						mapping.vaultSubfolder = v.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addToggle((t) =>
				t
					.setTooltip("Enabled")
					.setValue(mapping.enabled)
					.onChange(async (v) => {
						mapping.enabled = v;
						await this.plugin.saveSettings();
					}),
			)
			.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Remove")
					.onClick(async () => {
						account.labels.splice(idx, 1);
						await this.plugin.saveSettings();
						this.display();
					}),
			);
		row.infoEl.remove();
	}
}
