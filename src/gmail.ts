import { requestUrl, RequestUrlResponse } from "obsidian";
import { interactiveLogin, refreshAccessToken, TokenSet } from "./auth";
import {
	AccountSettings,
	CalEvent,
	GmailLabel,
	MailAttachment,
	MailMessage,
	Person,
	PluginSettings,
} from "./types";
import { info, log, logError, withTimeout, SyncCancelledError } from "./log";

const REQUEST_TIMEOUT_MS = 60_000;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";

/** Error carrying the HTTP status so callers can special-case (e.g. 404). */
export class GmailError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "GmailError";
	}
}

interface GmailInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

/** Case-insensitive header lookup for requestUrl's response headers. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return headers[key];
	}
	return undefined;
}

// ---- raw Gmail wire shapes (only the fields we read) ----

interface RawHeader {
	name: string;
	value: string;
}
interface RawPart {
	partId?: string;
	mimeType?: string;
	filename?: string;
	headers?: RawHeader[];
	body?: { attachmentId?: string; size?: number; data?: string };
	parts?: RawPart[];
}
interface RawMessage {
	id: string;
	threadId: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string;
	payload?: RawPart;
}

interface RawEvent {
	id: string;
	status?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: { dateTime?: string; date?: string; timeZone?: string };
	end?: { dateTime?: string; date?: string; timeZone?: string };
	organizer?: { email?: string; displayName?: string };
	attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
	hangoutLink?: string;
	htmlLink?: string;
	conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
	recurringEventId?: string;
}

export interface HistoryResult {
	addedIds: string[];
	removedIds: string[];
	newHistoryId: string | null;
}

/**
 * Thin Gmail + Google Calendar client for ONE account. Owns the in-memory
 * access token and refreshes it transparently; the refresh token lives on the
 * account, and persistence is delegated back to the plugin via `onTokens`.
 * The OAuth client (id + secret) is shared across accounts via `settings`.
 */
export class GmailClient {
	private token: TokenSet | null = null;
	private labelCache: GmailLabel[] | null = null;

	constructor(
		private settings: PluginSettings,
		private account: AccountSettings,
		private openBrowser: (url: string) => void,
		private onTokens: (refreshToken: string | null) => Promise<void>,
	) {}

	get isAuthenticated(): boolean {
		return !!this.account.refreshToken;
	}

	/** Interactive sign-in; stores the refresh token on the account. */
	async login(): Promise<void> {
		const tokens = await interactiveLogin(
			this.settings.clientId,
			this.settings.clientSecret,
			this.openBrowser,
		);
		this.token = tokens;
		this.account.refreshToken = tokens.refreshToken;
		await this.onTokens(tokens.refreshToken);
		log(`Interactive login complete (${this.account.displayName}).`);
	}

	async logout(): Promise<void> {
		this.token = null;
		this.labelCache = null;
		this.account.refreshToken = null;
		await this.onTokens(null);
	}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expiresAt - 60_000 > Date.now()) {
			return this.token.accessToken;
		}
		if (!this.account.refreshToken) {
			throw new Error(
				`Account "${this.account.displayName}" is not signed in. Open the plugin settings and connect it.`,
			);
		}
		log(`Refreshing access token (${this.account.displayName}).`);
		const tokens = await refreshAccessToken(
			this.settings.clientId,
			this.settings.clientSecret,
			this.account.refreshToken,
		);
		this.token = tokens;
		if (tokens.refreshToken && tokens.refreshToken !== this.account.refreshToken) {
			this.account.refreshToken = tokens.refreshToken;
			await this.onTokens(tokens.refreshToken);
		}
		return tokens.accessToken;
	}

	// Uses Obsidian's requestUrl (native request, no Origin header) rather than
	// the renderer's fetch, and wraps each call in a hard timeout so a hung
	// request throws instead of freezing the sync.
	private async gmailRequest(url: string, init: GmailInit = {}, attempt = 0): Promise<RequestUrlResponse> {
		const token = await this.accessToken();
		const headers: Record<string, string> = { ...(init.headers ?? {}), Authorization: `Bearer ${token}` };
		if (init.method && init.method !== "GET" && !("Content-Type" in headers)) {
			headers["Content-Type"] = "application/json";
		}
		const resp = await withTimeout(
			requestUrl({
				url,
				method: init.method ?? "GET",
				headers,
				body: init.body,
				throw: false,
			}),
			REQUEST_TIMEOUT_MS,
			`Gmail ${init.method ?? "GET"} request`,
		);

		// 401 → token likely stale; drop and retry once.
		if (resp.status === 401 && attempt === 0) {
			this.token = null;
			return this.gmailRequest(url, init, attempt + 1);
		}
		// 403 rateLimitExceeded / 429 / 5xx → back off and retry (up to 4 attempts).
		if ((resp.status === 429 || resp.status === 403 || resp.status === 500 || resp.status === 503) && attempt < 4) {
			// Only retry a 403 when it is actually a rate-limit (not a permission error).
			if (resp.status === 403 && !/rateLimitExceeded|userRateLimitExceeded|backendError/i.test(resp.text ?? "")) {
				return resp;
			}
			const retryAfter = Number(headerValue(resp.headers, "retry-after") ?? "0") * 1000;
			const wait = retryAfter || Math.min(16_000, 1000 * 2 ** attempt);
			log(`Throttled (${resp.status}); waiting ${wait}ms (attempt ${attempt + 1}).`);
			await sleep(wait);
			return this.gmailRequest(url, init, attempt + 1);
		}
		return resp;
	}

	private async gmailJson<T>(url: string, init: GmailInit = {}): Promise<T> {
		const resp = await this.gmailRequest(url, init);
		if (resp.status < 200 || resp.status >= 300) {
			const text = resp.text ?? "";
			logError(`Gmail ${init.method ?? "GET"} ${url} -> ${resp.status}`, text);
			throw new GmailError(`Gmail request failed (${resp.status}): ${text.slice(0, 300)}`, resp.status);
		}
		return resp.json as T;
	}

	/** Returns the signed-in mailbox address and current history cursor. */
	async profile(): Promise<{ emailAddress: string; historyId: string }> {
		return this.gmailJson(`${GMAIL}/profile`);
	}

	/** All labels (system + user), cached for the session. */
	async labels(): Promise<GmailLabel[]> {
		if (this.labelCache) return this.labelCache;
		const resp = await this.gmailJson<{ labels: GmailLabel[] }>(`${GMAIL}/labels`);
		this.labelCache = resp.labels ?? [];
		return this.labelCache;
	}

	/**
	 * Resolves a label string to its id. System labels (INBOX, SENT, …) map to
	 * their uppercased id directly; otherwise match a user label by display name
	 * (case-insensitive).
	 */
	async resolveLabelId(label: string): Promise<string> {
		const trimmed = label.trim();
		if (!trimmed) throw new Error("Empty label.");
		const labels = await this.labels();
		const upper = trimmed.toUpperCase();
		const byId = labels.find((l) => l.id.toUpperCase() === upper);
		if (byId) return byId.id;
		const byName = labels.find((l) => l.name?.toLowerCase() === trimmed.toLowerCase());
		if (byName) return byName.id;
		throw new Error(`Gmail label not found: "${label}".`);
	}

	/**
	 * Full enumeration of message ids in a label, following pageToken paging.
	 * `afterQuery` (a Gmail search string such as "after:2025/01/01") is optional.
	 */
	async listMessageIds(
		labelId: string,
		afterQuery: string,
		onProgress?: (fetched: number) => void,
		shouldCancel?: () => boolean,
	): Promise<{ id: string; threadId: string }[]> {
		const out: { id: string; threadId: string }[] = [];
		let pageToken: string | null = null;
		info(`Label ${labelId}: full enumeration${afterQuery ? ` (${afterQuery})` : ""}…`);
		do {
			if (shouldCancel?.()) throw cancelled();
			const params = new URLSearchParams({ labelIds: labelId, maxResults: "500" });
			if (afterQuery) params.set("q", afterQuery);
			if (pageToken) params.set("pageToken", pageToken);
			const page: { messages?: { id: string; threadId: string }[]; nextPageToken?: string } =
				await this.gmailJson(`${GMAIL}/messages?${params.toString()}`);
			for (const m of page.messages ?? []) out.push({ id: m.id, threadId: m.threadId });
			onProgress?.(out.length);
			pageToken = page.nextPageToken ?? null;
		} while (pageToken);
		info(`Label ${labelId}: ${out.length} message(s) enumerated.`);
		return out;
	}

	/** Fetches and parses a single message (format=full). */
	async getMessage(id: string): Promise<{ message: MailMessage; attachments: MailAttachment[] }> {
		const raw = await this.gmailJson<RawMessage>(
			`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`,
		);
		return parseMessage(raw);
	}

	/** Downloads one attachment's bytes. */
	async getAttachment(messageId: string, attachmentId: string): Promise<ArrayBuffer> {
		const resp = await this.gmailJson<{ data?: string; size?: number }>(
			`${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
		);
		return base64UrlToArrayBuffer(resp.data ?? "");
	}

	/**
	 * Incremental changes for a label since `startHistoryId`. Collects message ids
	 * added to (or labelled with) the label, and ids removed/deleted. Throws a
	 * GmailError(404) when the history cursor has expired — the caller should then
	 * re-enumerate from scratch (analogous to Graph's 410).
	 */
	async historySince(
		labelId: string,
		startHistoryId: string,
		shouldCancel?: () => boolean,
	): Promise<HistoryResult> {
		const added = new Set<string>();
		const removed = new Set<string>();
		let pageToken: string | null = null;
		let newHistoryId: string | null = null;

		info(`Label ${labelId}: fetching history since ${startHistoryId}…`);
		do {
			if (shouldCancel?.()) throw cancelled();
			const params = new URLSearchParams({
				startHistoryId,
				labelId,
				maxResults: "500",
			});
			// messageAdded + labelAdded cover "now in this label"; deleted/labelRemoved cover removal.
			for (const t of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) {
				params.append("historyTypes", t);
			}
			if (pageToken) params.set("pageToken", pageToken);

			const page: {
				history?: {
					messagesAdded?: { message: { id: string } }[];
					messagesDeleted?: { message: { id: string } }[];
					labelsAdded?: { message: { id: string }; labelIds: string[] }[];
					labelsRemoved?: { message: { id: string }; labelIds: string[] }[];
				}[];
				nextPageToken?: string;
				historyId?: string;
			} = await this.gmailJson(`${GMAIL}/history?${params.toString()}`);

			for (const h of page.history ?? []) {
				for (const a of h.messagesAdded ?? []) added.add(a.message.id);
				for (const a of h.labelsAdded ?? []) if (a.labelIds?.includes(labelId)) added.add(a.message.id);
				for (const d of h.messagesDeleted ?? []) removed.add(d.message.id);
				for (const r of h.labelsRemoved ?? []) if (r.labelIds?.includes(labelId)) removed.add(r.message.id);
			}
			newHistoryId = page.historyId ?? newHistoryId;
			pageToken = page.nextPageToken ?? null;
		} while (pageToken);

		// A message added then removed within the window nets to removed.
		for (const id of removed) added.delete(id);
		info(`Label ${labelId}: history → ${added.size} added, ${removed.size} removed.`);
		return { addedIds: [...added], removedIds: [...removed], newHistoryId };
	}

	/**
	 * Google Calendar events between two instants. `singleEvents=true` expands
	 * recurring series into individual occurrences; cancelled instances come back
	 * with status "cancelled".
	 */
	async listEvents(
		timeMin: string,
		timeMax: string,
		onProgress?: (fetched: number) => void,
		shouldCancel?: () => boolean,
	): Promise<CalEvent[]> {
		const out: CalEvent[] = [];
		let pageToken: string | null = null;
		info(`Calendar: fetching ${timeMin.slice(0, 10)} → ${timeMax.slice(0, 10)}…`);
		do {
			if (shouldCancel?.()) throw cancelled();
			const params = new URLSearchParams({
				timeMin,
				timeMax,
				singleEvents: "true",
				orderBy: "startTime",
				maxResults: "250",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const page: { items?: RawEvent[]; nextPageToken?: string } = await this.gmailJson(
				`${CALENDAR}/calendars/primary/events?${params.toString()}`,
			);
			for (const ev of page.items ?? []) out.push(parseEvent(ev));
			onProgress?.(out.length);
			pageToken = page.nextPageToken ?? null;
		} while (pageToken);
		info(`Calendar: ${out.length} event(s) in window.`);
		return out;
	}
}

// ---- message parsing ----

function parseMessage(raw: RawMessage): { message: MailMessage; attachments: MailAttachment[] } {
	const headers = raw.payload?.headers ?? [];
	const h = (name: string) => headerValueList(headers, name);

	const attachments: MailAttachment[] = [];
	const bodies = { html: "", text: "" };
	walkParts(raw.payload, bodies, attachments);

	const dateIso = raw.internalDate
		? new Date(Number(raw.internalDate)).toISOString()
		: parseHeaderDate(h("Date"));

	const message: MailMessage = {
		id: raw.id,
		threadId: raw.threadId,
		subject: h("Subject"),
		from: parseAddressList(h("From"))[0] ?? { name: "", email: "" },
		to: parseAddressList(h("To")),
		cc: parseAddressList(h("Cc")),
		dateIso,
		snippet: decodeEntities(raw.snippet ?? ""),
		bodyHtml: bodies.html || undefined,
		bodyText: bodies.text || undefined,
		labelIds: raw.labelIds ?? [],
		hasAttachments: attachments.length > 0,
		webLink: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(raw.id)}`,
	};
	return { message, attachments };
}

/** Depth-first walk collecting the best html/text body and file attachments. */
function walkParts(
	part: RawPart | undefined,
	bodies: { html: string; text: string },
	attachments: MailAttachment[],
): void {
	if (!part) return;
	const mime = part.mimeType ?? "";
	const isAttachment = !!part.filename && !!part.body?.attachmentId;
	if (isAttachment) {
		attachments.push({
			attachmentId: part.body!.attachmentId!,
			filename: part.filename!,
			mimeType: mime,
			size: part.body?.size ?? 0,
		});
	} else if (mime === "text/html" && part.body?.data && !bodies.html) {
		bodies.html = decodeBase64Url(part.body.data);
	} else if (mime === "text/plain" && part.body?.data && !bodies.text) {
		bodies.text = decodeBase64Url(part.body.data);
	}
	for (const child of part.parts ?? []) walkParts(child, bodies, attachments);
}

// ---- calendar parsing ----

function parseEvent(ev: RawEvent): CalEvent {
	const allDay = !!ev.start?.date && !ev.start?.dateTime;
	const startIso = normalizeCalTime(ev.start, allDay);
	const endIso = normalizeCalTime(ev.end, allDay);
	const video = ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
	return {
		id: ev.id,
		summary: ev.summary ?? "",
		description: ev.description ?? "",
		startIso,
		endIso,
		isAllDay: allDay,
		isCancelled: ev.status === "cancelled",
		location: ev.location ?? "",
		organizer: { name: ev.organizer?.displayName ?? "", email: ev.organizer?.email ?? "" },
		attendees: (ev.attendees ?? []).map((a) => ({
			name: a.displayName ?? "",
			email: a.email ?? "",
		})),
		hangoutLink: ev.hangoutLink || video || "",
		htmlLink: ev.htmlLink ?? "",
	};
}

function normalizeCalTime(t: RawEvent["start"], allDay: boolean): string {
	if (!t) return "";
	if (allDay) return t.date ?? "";
	if (!t.dateTime) return "";
	const d = new Date(t.dateTime);
	return isNaN(d.getTime()) ? t.dateTime : d.toISOString();
}

// ---- header + address helpers ----

function headerValueList(headers: RawHeader[], name: string): string {
	const lower = name.toLowerCase();
	const hit = headers.find((x) => x.name.toLowerCase() === lower);
	return hit?.value ?? "";
}

/**
 * Splits an RFC 5322 address list on commas that are outside quotes/angle
 * brackets, then parses each into name + email.
 */
function parseAddressList(raw: string): Person[] {
	if (!raw) return [];
	const parts: string[] = [];
	let buf = "";
	let inQuote = false;
	let inAngle = false;
	for (const ch of raw) {
		if (ch === '"') inQuote = !inQuote;
		else if (ch === "<") inAngle = true;
		else if (ch === ">") inAngle = false;
		if (ch === "," && !inQuote && !inAngle) {
			parts.push(buf);
			buf = "";
		} else {
			buf += ch;
		}
	}
	if (buf.trim()) parts.push(buf);
	return parts.map(parseAddress).filter((p) => p.email || p.name);
}

function parseAddress(raw: string): Person {
	const s = raw.trim();
	const angle = s.match(/^(.*)<([^>]+)>\s*$/);
	if (angle) {
		const name = angle[1].trim().replace(/^"(.*)"$/, "$1").trim();
		return { name, email: angle[2].trim() };
	}
	return { name: "", email: s.replace(/^"(.*)"$/, "$1") };
}

function parseHeaderDate(raw: string): string {
	if (!raw) return "";
	const d = new Date(raw);
	return isNaN(d.getTime()) ? "" : d.toISOString();
}

// ---- base64url ----

/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Node's Buffer resolves to `any` under the community review linter, whose TS program omits @types/node; false positives on desktop-only code, not real type holes. */
function base64UrlToBuffer(data: string): Buffer {
	const norm = data.replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(norm, "base64");
}

function decodeBase64Url(data: string): string {
	return base64UrlToBuffer(data).toString("utf8");
}

function base64UrlToArrayBuffer(data: string): ArrayBuffer {
	const buf = base64UrlToBuffer(data);
	// Copy into a standalone ArrayBuffer (Buffer may share a larger pool).
	const out = new Uint8Array(buf.length);
	out.set(buf);
	return out.buffer;
}
/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Closes the Buffer-interop disable above. */

/** Minimal HTML-entity decode for the plaintext snippet. */
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function cancelled(): Error {
	return new SyncCancelledError();
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}
