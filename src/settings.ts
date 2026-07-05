import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type GmailMailboxPlugin from "./main";
import { LabelMapping } from "./types";

export class GmailMailboxSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: GmailMailboxPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// --- Account / auth ---
		new Setting(containerEl).setName("Account").setHeading();
		containerEl.createEl("p", {
			text:
				"Create a Google Cloud OAuth client of type “Desktop app” (APIs & Services → Credentials), " +
				"enable the Gmail API and Google Calendar API, and add yourself as a test user on the OAuth consent screen. " +
				"Paste the Client ID and Client secret below. See README for the full walkthrough.",
			cls: "setting-item-description",
		});

		const status = this.plugin.gmail.isAuthenticated
			? `Connected${this.plugin.connectedAs ? ` as ${this.plugin.connectedAs}` : ""}`
			: "Not connected";
		new Setting(containerEl)
			.setName("Connection status")
			.setDesc(status)
			.addButton((b) =>
				b
					.setButtonText(this.plugin.gmail.isAuthenticated ? "Reconnect" : "Connect")
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						try {
							await this.plugin.connect();
							new Notice("Connected to Google.");
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
						await this.plugin.gmail.logout();
						new Notice("Disconnected.");
						this.display();
					}),
			);

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

		// --- Vault layout ---
		new Setting(containerEl).setName("Vault layout").setHeading();

		new Setting(containerEl)
			.setName("Target folder")
			.setDesc("Root vault folder that all mail notes live under.")
			.addText((t) =>
				t
					.setPlaceholder("10-Mailbox/Gmail")
					.setValue(s.targetFolder)
					.onChange(async (v) => {
						s.targetFolder = v.trim() || "10-Mailbox/Gmail";
						await this.plugin.saveSettings();
					}),
			);

		// --- Label mappings ---
		new Setting(containerEl).setName("Labels to sync").setHeading();
		containerEl.createEl("p", {
			text: "Map Gmail labels to vault subfolders. Use a system label (INBOX, SENT, STARRED, IMPORTANT) or a user label's name like Projects/ClientX.",
			cls: "setting-item-description",
		});

		s.labels.forEach((mapping, idx) => {
			this.renderLabelRow(containerEl, mapping, idx);
		});

		new Setting(containerEl).addButton((b) =>
			b
				.setButtonText("Add label")
				.setIcon("plus")
				.onClick(async () => {
					s.labels.push({ gmailLabel: "", vaultSubfolder: "", enabled: true });
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		// --- Sync behaviour ---
		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Sync mail newer than")
			.setDesc(
				"Only import mail received on/after this date (YYYY-MM-DD). Leave empty for all mail. Pushed to Gmail as an `after:` filter on the first sync.",
			)
			.addText((t) =>
				t
					.setPlaceholder("2025-01-01")
					.setValue(s.syncSince)
					.onChange(async (v) => {
						const val = v.trim();
						if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
							t.inputEl.addClass("gmail-mailbox-invalid");
							return;
						}
						t.inputEl.removeClass("gmail-mailbox-invalid");
						s.syncSince = val;
						await this.plugin.saveSettings();
					}),
			);

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

		// --- Calendar ---
		new Setting(containerEl).setName("Calendar").setHeading();
		containerEl.createEl("p", {
			text: "Requires the Google Calendar API and the calendar.readonly scope. If you enabled it after connecting, click Reconnect above to re-consent.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Sync calendar")
			.setDesc("Fetch upcoming events, write meeting notes, and show the Upcoming sidebar.")
			.addToggle((t) =>
				t.setValue(s.syncCalendar).onChange(async (v) => {
					s.syncCalendar = v;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (s.syncCalendar) {
			new Setting(containerEl)
				.setName("Days ahead")
				.setDesc("Rolling window of upcoming days to keep.")
				.addText((t) =>
					t.setValue(String(s.calendarDaysAhead)).onChange(async (v) => {
						s.calendarDaysAhead = Math.max(1, Math.floor(Number(v) || 14));
						await this.plugin.saveSettings();
					}),
				);

			new Setting(containerEl)
				.setName("Calendar subfolder")
				.setDesc("Vault subfolder (under the target folder) for meeting notes.")
				.addText((t) =>
					t
						.setPlaceholder("Calendar")
						.setValue(s.calendarSubfolder)
						.onChange(async (v) => {
							s.calendarSubfolder = v.trim() || "Calendar";
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Link related emails")
				.setDesc("Cross-link meeting notes to email notes sharing attendees or subject.")
				.addToggle((t) =>
					t.setValue(s.linkRelatedEmails).onChange(async (v) => {
						s.linkRelatedEmails = v;
						await this.plugin.saveSettings();
					}),
				);

			new Setting(containerEl).setName("Upcoming panel").addButton((b) =>
				b.setButtonText("Open sidebar").onClick(() => this.plugin.activateUpcomingView()),
			);
		}

		// --- Maintenance ---
		new Setting(containerEl).setName("Maintenance").setHeading();
		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Stop halts the running sync at the next message/page; already-written notes are kept.")
			.addButton((b) =>
				b
					.setButtonText("Sync now")
					.setCta()
					.setDisabled(this.plugin.sync.isRunning)
					.onClick(() => {
						// Fire without awaiting so the panel can re-render immediately
						// (enabling Stop); re-render again when the run settles.
						void this.plugin.runSync().finally(() => this.display());
						this.display();
					}),
			)
			.addButton((b) => {
				b.setButtonText("Stop")
					.setDisabled(!this.plugin.sync.isRunning)
					.onClick(() => {
						this.plugin.stopSync();
						this.display();
					});
				b.buttonEl.addClass("mod-warning");
			});

		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc(
				"Clears history cursors and the thread index so the next sync re-enumerates all messages. Existing notes are kept.",
			)
			.addButton((b) => {
				b.setButtonText("Reset").onClick(async () => {
					this.plugin.sync.resetState();
					await this.plugin.saveSettings();
					new Notice("Sync state reset. Next sync will do a full enumeration.");
				});
				b.buttonEl.addClass("mod-warning");
			});

		if (s.lastSync) {
			containerEl.createEl("p", {
				text: `Last sync: ${new Date(s.lastSync).toLocaleString()}`,
				cls: "setting-item-description",
			});
		}
	}

	private renderLabelRow(containerEl: HTMLElement, mapping: LabelMapping, idx: number): void {
		const s = this.plugin.settings;
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
						s.labels.splice(idx, 1);
						await this.plugin.saveSettings();
						this.display();
					}),
			);
		row.infoEl.remove();
	}
}
