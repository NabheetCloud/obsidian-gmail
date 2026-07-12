import { GmailClient, GmailError } from "./gmail";
import { NoteWriter } from "./notes";
import {
	AccountSettings,
	CalEvent,
	LabelMapping,
	MailMessage,
	PluginSettings,
	ThreadEntry,
	ThreadMessageRef,
	UpcomingEvent,
} from "./types";
import { info, log, warn, SyncCancelledError } from "./log";

interface EmailRef {
	notePath: string;
	receivedIso: string;
}
interface EmailIndex {
	byPerson: Map<string, EmailRef[]>;
	bySubject: Map<string, EmailRef[]>;
}

export interface SyncReport {
	added: number;
	updated: number;
	removed: number;
	labels: number;
	events: number;
	errors: string[];
	/** True when the user stopped the sync before it finished. */
	cancelled: boolean;
}

export interface SyncProgress {
	label: string;
	phase: "listing" | "writing";
	processed: number;
	/** Total known once listing completes; null while still listing. */
	total: number | null;
}

function threadKey(vaultSubfolder: string, threadId: string): string {
	return `${vaultSubfolder}::${threadId || "no-thread"}`;
}

function vaultSubfolderFor(m: LabelMapping): string {
	return (m.vaultSubfolder || m.gmailLabel).replace(/[\\/:*?"<>|]/g, "_").trim() || "Mail";
}

/** Sync engine for ONE account; the plugin runs one per configured account. */
export class SyncEngine {
	private running = false;
	private cancelRequested = false;

	constructor(
		private settings: PluginSettings,
		private account: AccountSettings,
		private gmail: GmailClient,
		private notes: NoteWriter,
		private save: () => Promise<void>,
		private onProgress: (p: SyncProgress) => void = () => {},
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	get isCancelling(): boolean {
		return this.running && this.cancelRequested;
	}

	/**
	 * Cooperative stop. Sets a flag the listing and write loops check between
	 * items/pages, so the current sync unwinds cleanly at the next checkpoint
	 * (no half-written note, and the interrupted label's history cursor is left
	 * untouched so the next sync re-fetches it). No-op if idle.
	 */
	requestCancel(): void {
		if (this.running) {
			this.cancelRequested = true;
			info("Stop requested; sync will halt at the next checkpoint.");
		}
	}

	/** Syncs every enabled label. Returns aggregate counts. */
	async syncAll(): Promise<SyncReport> {
		if (this.running) throw new Error("A sync is already in progress.");
		if (!this.gmail.isAuthenticated) throw new Error("Not signed in.");
		this.running = true;
		this.cancelRequested = false;
		const report: SyncReport = {
			added: 0,
			updated: 0,
			removed: 0,
			labels: 0,
			events: 0,
			errors: [],
			cancelled: false,
		};
		try {
			const enabled = this.account.labels.filter((f) => f.enabled && f.gmailLabel.trim());
			info(`[${this.account.displayName}] Sync started: ${enabled.length} label(s).`);
			for (const mapping of enabled) {
				if (this.cancelRequested) {
					report.cancelled = true;
					break;
				}
				try {
					await this.syncLabel(mapping, report);
					report.labels++;
				} catch (e) {
					if (e instanceof SyncCancelledError) {
						report.cancelled = true;
						break;
					}
					const msg = `Label "${mapping.gmailLabel}": ${(e as Error).message}`;
					warn(msg);
					report.errors.push(msg);
				}
			}

			if (!report.cancelled && this.account.syncCalendar) {
				try {
					await this.syncCalendarStep(report);
				} catch (e) {
					if (e instanceof SyncCancelledError) {
						report.cancelled = true;
					} else {
						const msg = `Calendar: ${(e as Error).message}`;
						warn(msg);
						report.errors.push(msg);
					}
				}
			}

			// lastSync is only stamped on a full run so a stopped sync doesn't
			// masquerade as up-to-date.
			if (!report.cancelled) this.account.lastSync = new Date().toISOString();
			await this.save();
			info(
				`[${this.account.displayName}] ` +
					(report.cancelled ? "Sync stopped: " : "Sync complete: ") +
					`+${report.added} new, ${report.updated} updated, ` +
					`${report.removed} removed across ${report.labels} label(s); ` +
					`${report.events} event(s); ${report.errors.length} error(s).`,
			);
			return report;
		} finally {
			this.running = false;
			this.cancelRequested = false;
		}
	}

	private async syncLabel(mapping: LabelMapping, report: SyncReport): Promise<void> {
		const vaultSubfolder = vaultSubfolderFor(mapping);
		info(`Syncing "${mapping.gmailLabel}" → ${vaultSubfolder}`);
		const labelId = await this.gmail.resolveLabelId(mapping.gmailLabel);
		const shouldCancel = () => this.cancelRequested;
		const cutoff = validCutoff(this.account.syncSince);
		const touchedThreadKeys = new Set<string>();

		const priorHistory = this.account.historyIds[labelId];
		let addIds: string[];
		let removeIds: string[] = [];
		let newHistoryId: string | null = null;

		if (priorHistory) {
			// Incremental: history since the stored cursor.
			try {
				const h = await this.gmail.historySince(labelId, priorHistory, shouldCancel);
				addIds = h.addedIds;
				removeIds = h.removedIds;
				newHistoryId = h.newHistoryId ?? priorHistory;
			} catch (e) {
				// A history cursor expires after ~a week of inactivity → Gmail
				// returns 404. Expected: drop it and re-enumerate from scratch.
				if (e instanceof GmailError && e.status === 404) {
					info(`History cursor expired for "${vaultSubfolder}"; re-enumerating from scratch.`);
					delete this.account.historyIds[labelId];
					({ addIds, newHistoryId } = await this.fullEnumerate(labelId, cutoff, vaultSubfolder, shouldCancel));
				} else {
					throw e;
				}
			}
		} else {
			({ addIds, newHistoryId } = await this.fullEnumerate(labelId, cutoff, vaultSubfolder, shouldCancel));
		}

		// Process removals first (cheap, no network).
		for (const id of removeIds) {
			if (this.removeMessage(id, touchedThreadKeys)) report.removed++;
		}

		// Fetch + write each added/changed message.
		const total = addIds.length;
		let done = 0;
		let skipped = 0;
		let cancelled = false;
		for (const id of addIds) {
			if (this.cancelRequested) {
				cancelled = true;
				info(`"${vaultSubfolder}": stopped by user after writing ${done}/${total}.`);
				break;
			}
			try {
				const { message, attachments } = await this.gmail.getMessage(id);
				if (cutoff && messageDate(message) < cutoff) {
					skipped++;
				} else {
					const isUpdate = this.messageExists(message.id);
					const { ref } = await this.notes.writeMessage(message, vaultSubfolder);
					this.upsertThread(vaultSubfolder, message, ref, touchedThreadKeys);
					if (this.settings.downloadAttachments && message.hasAttachments) {
						await this.saveAttachments(vaultSubfolder, message.id, attachments, report);
					}
					if (isUpdate) report.updated++;
					else report.added++;
				}
			} catch (e) {
				// One bad message must not abort the whole label.
				const msgErr = `Message "${id}": ${(e as Error).message}`;
				warn(msgErr);
				report.errors.push(msgErr);
			}
			done++;
			if (done % 10 === 0 || done === total) {
				this.onProgress({ label: vaultSubfolder, phase: "writing", processed: done, total });
				if (done % 100 === 0 || done === total) info(`${vaultSubfolder}: wrote ${done}/${total}`);
			}
		}

		// Persist the new history cursor so the next run is incremental, but only
		// if the label finished. On a stopped sync the remaining messages weren't
		// written, so we keep the old cursor (or none) to force a re-fetch.
		if (newHistoryId && !cancelled) this.account.historyIds[labelId] = newHistoryId;

		info(
			`"${vaultSubfolder}" ${cancelled ? "stopped" : "done"}: ${done}/${total} processed` +
				(skipped ? `, ${skipped} skipped (older than ${cutoff})` : "") +
				(removeIds.length ? `, ${removeIds.length} removed` : ""),
		);

		if (touchedThreadKeys.size > 0) {
			const threads = this.threadsForSubfolder(vaultSubfolder);
			await this.notes.writeThreadIndex(vaultSubfolder, threads);
		}

		if (cancelled) throw new SyncCancelledError();
	}

	/**
	 * Full enumeration of a label. Captures the mailbox history cursor BEFORE
	 * listing so any message arriving mid-listing is picked up by the next
	 * incremental sync rather than being silently skipped.
	 */
	private async fullEnumerate(
		labelId: string,
		cutoff: string | null,
		vaultSubfolder: string,
		shouldCancel: () => boolean,
	): Promise<{ addIds: string[]; newHistoryId: string | null }> {
		const profile = await this.gmail.profile();
		const afterQuery = cutoff ? `after:${cutoff.replace(/-/g, "/")}` : "";
		const onList = (n: number) =>
			this.onProgress({ label: vaultSubfolder, phase: "listing", processed: n, total: null });
		const ids = await this.gmail.listMessageIds(labelId, afterQuery, onList, shouldCancel);
		return { addIds: ids.map((m) => m.id), newHistoryId: profile.historyId };
	}

	/**
	 * Fetches the upcoming calendar window, writes one note per event (with
	 * related-email links), reconciles cancelled/expired events, and refreshes
	 * the Upcoming sidebar cache.
	 */
	private async syncCalendarStep(report: SyncReport): Promise<void> {
		const subfolder =
			(this.account.calendarSubfolder || "Calendar").replace(/[\\/:*?"<>|]/g, "_").trim() ||
			"Calendar";
		const days = Math.max(1, this.account.calendarDaysAhead || 14);
		const now = new Date();
		const timeMin = now.toISOString();
		const timeMax = new Date(now.getTime() + days * 86_400_000).toISOString();

		const events = await this.gmail.listEvents(
			timeMin,
			timeMax,
			(n) => this.onProgress({ label: "Calendar", phase: "listing", processed: n, total: null }),
			() => this.cancelRequested,
		);

		const index = this.account.linkRelatedEmails ? this.buildEmailIndex() : null;
		const currentIds = new Set<string>();
		const upcoming: UpcomingEvent[] = [];
		const total = events.length;
		let done = 0;

		for (const ev of events) {
			if (this.cancelRequested) {
				info(`Calendar: stopped by user after ${done}/${total}.`);
				throw new SyncCancelledError();
			}
			done++;
			if (done % 10 === 0 || done === total) {
				this.onProgress({ label: "Calendar", phase: "writing", processed: done, total });
			}
			if (ev.isCancelled) continue; // left out of currentIds → note reconciled away

			const related = index ? this.matchRelatedEmails(ev, index) : [];
			const notePath = await this.notes.writeEvent(ev, subfolder, related);
			this.account.calendarNotes[ev.id] = notePath;
			currentIds.add(ev.id);
			report.events++;

			upcoming.push({
				id: ev.id,
				accountName: this.account.displayName,
				subject: ev.summary?.trim() || "(no title)",
				startIso: ev.startIso,
				endIso: ev.endIso,
				isAllDay: ev.isAllDay,
				location: ev.location,
				notePath,
				onlineUrl: ev.hangoutLink,
				webLink: ev.htmlLink,
			});
		}

		// Reconcile: any previously-written event no longer in the window
		// (cancelled, moved out, past) gets its note trashed.
		for (const [id, notePath] of Object.entries(this.account.calendarNotes)) {
			if (!currentIds.has(id)) {
				await this.notes.deleteEventNote(notePath);
				delete this.account.calendarNotes[id];
			}
		}

		upcoming.sort((a, b) => (a.startIso < b.startIso ? -1 : 1));
		this.account.upcomingCache = upcoming;
		info(`[${this.account.displayName}] Calendar done: ${upcoming.length} upcoming event(s).`);
	}

	/** Indexes email notes by participant email and normalized subject. */
	private buildEmailIndex(): EmailIndex {
		const byPerson = new Map<string, EmailRef[]>();
		const bySubject = new Map<string, EmailRef[]>();
		const push = (map: Map<string, EmailRef[]>, key: string, ref: EmailRef) => {
			const arr = map.get(key);
			if (arr) arr.push(ref);
			else map.set(key, [ref]);
		};
		for (const t of Object.values(this.account.threads)) {
			for (const m of t.messages) {
				const ref: EmailRef = { notePath: m.notePath, receivedIso: m.receivedIso };
				const subj = normalizeSubject(m.subject).toLowerCase();
				if (subj) push(bySubject, subj, ref);
				for (const p of m.people ?? []) push(byPerson, p, ref);
			}
		}
		return { byPerson, bySubject };
	}

	/**
	 * Related email notes for an event: exact normalized-subject matches (strong),
	 * plus emails with a shared participant received within 21 days before the
	 * meeting (to avoid over-linking every mail from a frequent contact). Capped.
	 */
	private matchRelatedEmails(ev: CalEvent, index: EmailIndex): string[] {
		const score = new Map<string, number>();
		const bump = (notePath: string, s: number) =>
			score.set(notePath, Math.max(score.get(notePath) ?? 0, s));

		const subj = normalizeSubject(ev.summary).toLowerCase();
		if (subj) for (const r of index.bySubject.get(subj) ?? []) bump(r.notePath, 2);

		const emails = [ev.organizer.email, ...ev.attendees.map((a) => a.email)]
			.filter(Boolean)
			.map((e) => e.toLowerCase());
		const startMs = isNaN(Date.parse(ev.startIso)) ? Date.now() : Date.parse(ev.startIso);
		const windowStart = new Date(startMs - 21 * 86_400_000).toISOString();
		for (const e of emails) {
			for (const r of index.byPerson.get(e) ?? []) {
				if (r.receivedIso >= windowStart) bump(r.notePath, 1);
			}
		}

		return [...score.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([notePath]) => notePath);
	}

	private async saveAttachments(
		vaultSubfolder: string,
		messageId: string,
		attachments: { attachmentId: string; filename: string; size: number }[],
		report: SyncReport,
	): Promise<void> {
		try {
			const limit = this.settings.maxAttachmentMB * 1024 * 1024;
			for (const a of attachments) {
				if (!a.attachmentId) continue;
				if (limit > 0 && a.size > limit) {
					log(`Skipping oversized attachment ${a.filename} (${a.size} bytes).`);
					continue;
				}
				const bytes = await this.gmail.getAttachment(messageId, a.attachmentId);
				await this.notes.writeAttachment(vaultSubfolder, messageId, a.filename, bytes);
			}
		} catch (e) {
			report.errors.push(`Attachments for "${messageId}": ${(e as Error).message}`);
		}
	}

	// ---- thread bookkeeping ----

	private messageExists(id: string): boolean {
		for (const t of Object.values(this.account.threads)) {
			if (t.messages.some((m) => m.id === id)) return true;
		}
		return false;
	}

	private upsertThread(
		vaultSubfolder: string,
		msg: MailMessage,
		ref: ThreadMessageRef,
		touched: Set<string>,
	): void {
		const key = threadKey(vaultSubfolder, msg.threadId ?? "");
		let entry: ThreadEntry | undefined = this.account.threads[key];
		if (!entry) {
			entry = {
				threadId: msg.threadId ?? "",
				vaultSubfolder,
				subject: normalizeSubject(msg.subject),
				messages: [],
			};
			this.account.threads[key] = entry;
		}
		const existingIdx = entry.messages.findIndex((m) => m.id === ref.id);
		if (existingIdx >= 0) entry.messages[existingIdx] = ref;
		else entry.messages.push(ref);
		const norm = normalizeSubject(msg.subject);
		if (norm && (!entry.subject || norm.length < entry.subject.length)) entry.subject = norm;
		touched.add(key);
	}

	private removeMessage(id: string, touched: Set<string>): boolean {
		for (const [key, t] of Object.entries(this.account.threads)) {
			const idx = t.messages.findIndex((m) => m.id === id);
			if (idx >= 0) {
				const [ref] = t.messages.splice(idx, 1);
				void this.notes.deleteMessageNote(ref.notePath);
				touched.add(key);
				if (t.messages.length === 0) delete this.account.threads[key];
				return true;
			}
		}
		return false;
	}

	private threadsForSubfolder(vaultSubfolder: string): ThreadEntry[] {
		return Object.values(this.account.threads).filter((t) => t.vaultSubfolder === vaultSubfolder);
	}

	/** Clears this account's history + thread state so the next sync re-enumerates. */
	resetState(): void {
		this.account.historyIds = {};
		this.account.threads = {};
		this.account.calendarNotes = {};
		this.account.upcomingCache = [];
		this.account.lastSync = null;
	}
}

/** Returns a valid YYYY-MM-DD cutoff, or null if unset/malformed. */
function validCutoff(since: string): string | null {
	return /^\d{4}-\d{2}-\d{2}$/.test(since.trim()) ? since.trim() : null;
}

/** Message date as YYYY-MM-DD for comparison against the cutoff. */
function messageDate(msg: MailMessage): string {
	return (msg.dateIso ?? "").slice(0, 10);
}

function normalizeSubject(subject?: string): string {
	return (
		(subject ?? "").replace(/^(\s*(re|fw|fwd|aw|wg)\s*:\s*)+/i, "").trim() || (subject ?? "").trim()
	);
}
