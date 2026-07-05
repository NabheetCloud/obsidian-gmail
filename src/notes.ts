import { App, normalizePath, TFile, TFolder } from "obsidian";
import TurndownService from "turndown";
import { CalEvent, MailMessage, Person, PluginSettings, ThreadEntry, ThreadMessageRef } from "./types";
import { log } from "./log";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
// Drop noisy signature/style cruft.
turndown.remove(["style", "script"]);

export class NoteWriter {
	constructor(private app: App, private settings: PluginSettings) {}

	private get root(): string {
		return normalizePath(this.settings.targetFolder);
	}

	/** Ensures every folder along a vault-relative path exists. */
	private async ensureFolder(path: string): Promise<void> {
		const norm = normalizePath(path);
		if (norm === "" || norm === "/") return;
		const existing = this.app.vault.getAbstractFileByPath(norm);
		if (existing instanceof TFolder) return;
		const parts = norm.split("/");
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				try {
					await this.app.vault.createFolder(cur);
				} catch (e) {
					// Race: another writer may have just created it.
					if (!this.app.vault.getAbstractFileByPath(cur)) throw e;
				}
			}
		}
	}

	/**
	 * Creates or overwrites a note, tolerating an "already exists" race (the
	 * vault index can briefly lag a just-created file).
	 */
	private async writeFile(path: string, content: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return;
		}
		try {
			await this.app.vault.create(path, content);
		} catch (e) {
			const again = this.app.vault.getAbstractFileByPath(path);
			if (again instanceof TFile) await this.app.vault.modify(again, content);
			else throw e;
		}
	}

	/**
	 * Writes (or overwrites) the note for a single message.
	 * Returns the vault-relative note path and a thread reference.
	 */
	async writeMessage(
		msg: MailMessage,
		vaultSubfolder: string,
	): Promise<{ notePath: string; ref: ThreadMessageRef }> {
		const folder = normalizePath(`${this.root}/${vaultSubfolder}`);
		await this.ensureFolder(folder);

		const datePrefix = msg.dateIso ? msg.dateIso.slice(0, 10) : "no-date";
		const subject = msg.subject?.trim() || "(no subject)";
		const fileName = `${datePrefix} ${slug(subject)} ${shortId(msg.id)}.md`;
		const notePath = normalizePath(`${folder}/${fileName}`);

		const content = this.renderMarkdown(msg, vaultSubfolder);
		await this.writeFile(notePath, content);

		const people = [msg.from, ...msg.to, ...msg.cc]
			.map((p) => p.email)
			.filter(Boolean)
			.map((e) => e.toLowerCase());
		const ref: ThreadMessageRef = {
			id: msg.id,
			notePath,
			from: personName(msg.from),
			receivedIso: msg.dateIso,
			subject,
			people: Array.from(new Set(people)),
		};
		return { notePath, ref };
	}

	/** Deletes the note backing a removed message, if present. */
	async deleteMessageNote(notePath: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(notePath));
		if (f instanceof TFile) {
			await this.app.fileManager.trashFile(f);
			log("Trashed removed message note:", notePath);
		}
	}

	/**
	 * Writes (or overwrites) a meeting note. `relatedNotes` are vault-relative
	 * paths of email notes to cross-link. Returns the note path.
	 */
	async writeEvent(ev: CalEvent, vaultSubfolder: string, relatedNotes: string[]): Promise<string> {
		const folder = normalizePath(`${this.root}/${vaultSubfolder}`);
		await this.ensureFolder(folder);

		const datePrefix = ev.startIso.slice(0, 10);
		const subject = ev.summary?.trim() || "(no title)";
		const fileName = `${datePrefix} ${slug(subject)} ${shortId(ev.id)}.md`;
		const notePath = normalizePath(`${folder}/${fileName}`);

		const content = this.renderEvent(ev, relatedNotes);
		await this.writeFile(notePath, content);
		return notePath;
	}

	async deleteEventNote(notePath: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(notePath));
		if (f instanceof TFile) {
			await this.app.fileManager.trashFile(f);
			log("Trashed removed/cancelled event note:", notePath);
		}
	}

	private renderEvent(ev: CalEvent, relatedNotes: string[]): string {
		const fm: Record<string, unknown> = {
			source: "gmail",
			type: "meeting",
			event_id: ev.id,
			title: ev.summary,
			start: ev.startIso,
			end: ev.endIso,
			all_day: ev.isAllDay,
			organizer: ev.organizer.email,
			attendees: ev.attendees.map((a) => a.email).filter(Boolean),
			location: ev.location,
			online_url: ev.hangoutLink,
			web_link: ev.htmlLink,
		};

		const when = ev.isAllDay
			? `${ev.startIso.slice(0, 10)} (all day)`
			: `${fmtLocal(ev.startIso)} – ${fmtLocal(ev.endIso)}`;

		const bodyMd = looksHtml(ev.description ?? "")
			? turndown.turndown(ev.description ?? "")
			: (ev.description ?? "").trim();

		const lines: string[] = [
			yaml(fm),
			"",
			`# ${escapeMd(ev.summary?.trim() || "(no title)")}`,
			"",
			`**When:** ${when}`,
			ev.location ? `**Where:** ${escapeMd(ev.location)}` : "",
			`**Organizer:** ${escapeMd(personDisplay(ev.organizer))}`,
			ev.attendees.length
				? `**Attendees:** ${ev.attendees.map((a) => escapeMd(personDisplay(a))).join(", ")}`
				: "",
			ev.hangoutLink ? `**[Join online](${ev.hangoutLink})**` : "",
			ev.htmlLink ? `**[Open in Google Calendar](${ev.htmlLink})**` : "",
		].filter(Boolean);

		if (relatedNotes.length) {
			lines.push("", "## Related emails");
			for (const p of relatedNotes) lines.push(`- ${vaultLink(p)}`);
		}

		lines.push("", "---", "", bodyMd, "");
		return lines.join("\n");
	}

	private renderMarkdown(msg: MailMessage, vaultSubfolder: string): string {
		const fm: Record<string, unknown> = {
			source: "gmail",
			message_id: msg.id,
			thread_id: msg.threadId,
			subject: msg.subject,
			from: msg.from.email,
			from_name: msg.from.name,
			to: msg.to.map((p) => p.email).filter(Boolean),
			cc: msg.cc.map((p) => p.email).filter(Boolean),
			date: msg.dateIso,
			folder: vaultSubfolder,
			labels: msg.labelIds,
			has_attachments: msg.hasAttachments,
			web_link: msg.webLink,
		};

		let bodyMd = "";
		if (msg.bodyHtml) bodyMd = turndown.turndown(msg.bodyHtml);
		else bodyMd = (msg.bodyText || msg.snippet || "").trim();

		const toLine = msg.to.map(personDisplay).join(", ") || "—";
		const ccLine = msg.cc.map(personDisplay).join(", ");

		const header =
			`# ${escapeMd(msg.subject?.trim() || "(no subject)")}\n\n` +
			`**From:** ${escapeMd(personDisplay(msg.from))}\n` +
			`**To:** ${escapeMd(toLine)}\n` +
			(ccLine ? `**Cc:** ${escapeMd(ccLine)}\n` : "") +
			`**Date:** ${msg.dateIso}\n` +
			(msg.webLink ? `**[Open in Gmail](${msg.webLink})**\n` : "") +
			`\n---\n\n`;

		return `${yaml(fm)}\n${header}${bodyMd}\n`;
	}

	/**
	 * Regenerates a label's thread-index note from the in-memory thread map.
	 * Threads sorted by most recent activity; messages within a thread oldest→newest.
	 */
	async writeThreadIndex(vaultSubfolder: string, threads: ThreadEntry[]): Promise<void> {
		const folder = normalizePath(`${this.root}/${vaultSubfolder}`);
		await this.ensureFolder(folder);
		const indexPath = normalizePath(`${folder}/_Thread Index.md`);

		const sorted = threads
			.map((t) => ({
				t,
				latest: t.messages.reduce((m, x) => (x.receivedIso > m ? x.receivedIso : m), ""),
			}))
			.sort((a, b) => (a.latest < b.latest ? 1 : -1));

		const lines: string[] = [
			"---",
			"source: gmail",
			"type: thread-index",
			`folder: ${vaultSubfolder}`,
			`thread_count: ${threads.length}`,
			"---",
			"",
			`# Thread Index — ${vaultSubfolder}`,
			"",
			`> ${threads.length} conversation(s). Auto-generated by the Gmail Mailbox plugin.`,
			"",
		];

		for (const { t, latest } of sorted) {
			const msgs = [...t.messages].sort((a, b) => (a.receivedIso < b.receivedIso ? -1 : 1));
			lines.push(`## ${escapeMd(t.subject || "(no subject)")}`);
			lines.push(`*${msgs.length} message(s) · last activity ${latest.slice(0, 10) || "—"}*`);
			lines.push("");
			for (const m of msgs) {
				const link = vaultLink(m.notePath);
				lines.push(`- ${m.receivedIso.slice(0, 10) || "—"} — **${escapeMd(m.from)}** — ${link}`);
			}
			lines.push("");
		}

		await this.writeFile(indexPath, lines.join("\n"));
	}

	/** Saves file attachments under `<subfolder>/_attachments/<shortId>/`. */
	async writeAttachment(
		vaultSubfolder: string,
		messageId: string,
		name: string,
		bytes: ArrayBuffer,
	): Promise<string> {
		const dir = normalizePath(`${this.root}/${vaultSubfolder}/_attachments/${shortId(messageId)}`);
		await this.ensureFolder(dir);
		const path = normalizePath(`${dir}/${sanitizeFileName(name)}`);
		if (!this.app.vault.getAbstractFileByPath(path)) {
			await this.app.vault.createBinary(path, bytes);
		}
		return path;
	}
}

// ---- helpers ----

function personName(p: Person): string {
	return p.name || p.email || "Unknown";
}
function personDisplay(p: Person): string {
	if (p.name && p.email && p.name !== p.email) return `${p.name} <${p.email}>`;
	return p.email || p.name || "Unknown";
}

function looksHtml(s: string): boolean {
	return /<[a-z][\s\S]*>/i.test(s);
}

/** Formats a UTC ISO string as a local, human-readable datetime. */
function fmtLocal(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	return d.toLocaleString([], {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function slug(s: string): string {
	return s
		.replace(/[\r\n]+/g, " ")
		.replace(/[\\/:*?"<>|#^[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80)
		.trim();
}

function sanitizeFileName(s: string): string {
	return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "attachment";
}

function shortId(id: string): string {
	// FNV-1a 32-bit hash of the FULL id → base36. Hashing the whole id (rather
	// than a suffix slice) yields a stable, collision-resistant filename token.
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

function vaultLink(notePath: string): string {
	const base = notePath.split("/").pop() ?? notePath;
	const noExt = base.replace(/\.md$/, "");
	return `[[${noExt}]]`;
}

function escapeMd(s: string): string {
	return s.replace(/([\\`*_{}\[\]])/g, "\\$1");
}

function yaml(obj: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [k, v] of Object.entries(obj)) {
		if (Array.isArray(v)) {
			if (v.length === 0) {
				lines.push(`${k}: []`);
			} else {
				lines.push(`${k}:`);
				for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
			}
		} else {
			lines.push(`${k}: ${yamlScalar(v)}`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

function yamlScalar(v: unknown): string {
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	const s = String(v ?? "");
	if (s === "") return '""';
	if (/[:#\[\]{}",&*!|>'%@`]/.test(s) || /^\s|\s$/.test(s)) {
		return `"${s.replace(/"/g, '\\"')}"`;
	}
	return s;
}
