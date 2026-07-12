// Shared types for the Gmail Mailbox plugin.

/** A single Gmail label the user wants mirrored into the vault. */
export interface LabelMapping {
	/**
	 * The Gmail label. Either a system label id (case-insensitive: INBOX, SENT,
	 * STARRED, IMPORTANT, …) or a user label's display name, e.g. "Projects/ClientX".
	 * Resolved to a label id at sync time.
	 */
	gmailLabel: string;
	/**
	 * Vault-relative subfolder under `targetFolder` where notes for this label
	 * land. If empty, a slug of `gmailLabel` is used.
	 */
	vaultSubfolder: string;
	/** Whether this mapping participates in sync. */
	enabled: boolean;
}

/**
 * One connected Google account. Everything account-specific lives here,
 * including the persisted runtime state, so accounts never share sync state
 * even when they use the same label names. Vault paths are the one shared
 * namespace: keep each account's targetFolder distinct (the settings UI
 * defaults new accounts to an unused folder).
 */
export interface AccountSettings {
	/** Stable internal id; never changes after creation. */
	id: string;
	/** Label shown in settings, notices, and the Upcoming sidebar (e.g. "Work"). */
	displayName: string;
	/** Connected mailbox address; filled in after a successful login. */
	emailAddress: string | null;

	// --- Vault layout ---
	/** Root vault folder for this account's mail, e.g. "10-Mailbox/Gmail". */
	targetFolder: string;
	labels: LabelMapping[];

	// --- Sync behaviour ---
	/**
	 * Only write mail received on/after this date (YYYY-MM-DD). Empty = all mail.
	 * Pushed to Gmail as `after:` on the initial list; applied as a client-side
	 * write-filter on incremental history syncs.
	 */
	syncSince: string;

	// --- Calendar ---
	/** Fetch Google Calendar events and show them in the Upcoming sidebar. */
	syncCalendar: boolean;
	/** Rolling window size in days for upcoming events. */
	calendarDaysAhead: number;
	/** Vault subfolder (under targetFolder) for meeting notes. */
	calendarSubfolder: string;
	/** Cross-link meeting notes to related email notes. */
	linkRelatedEmails: boolean;

	// --- Persisted runtime state (not user-editable in the UI) ---
	/** Encrypted-at-rest is NOT applied; see README security note. */
	refreshToken: string | null;
	/** Gmail history cursor keyed by resolved label id. */
	historyIds: Record<string, string>;
	/** Thread index keyed by `${vaultSubfolder}::${threadId}`. */
	threads: Record<string, ThreadEntry>;
	/** Event id → note path, for reconciling removed/cancelled meetings. */
	calendarNotes: Record<string, string>;
	/** Cached upcoming events for the sidebar (rebuilt each calendar sync). */
	upcomingCache: UpcomingEvent[];
	/** ISO timestamp of last successful sync. */
	lastSync: string | null;
}

export interface PluginSettings {
	// --- Google Cloud OAuth client (Desktop app), shared by every account ---
	clientId: string;
	/**
	 * Desktop-app client secret. Google's installed-app secret is NOT confidential
	 * (it ships with the app) but Google's token endpoint still requires it for
	 * the "Desktop app" client type, even under PKCE.
	 */
	clientSecret: string;

	/** Connected Google accounts. Always at least one entry. */
	accounts: AccountSettings[];

	// --- Sync behaviour (shared) ---
	/** Auto-sync interval in minutes. 0 disables the timer. */
	syncIntervalMinutes: number;
	/** Sync automatically when Obsidian starts. */
	syncOnStartup: boolean;
	/** Save attachments alongside notes under an `_attachments` subfolder. */
	downloadAttachments: boolean;
	/** Max attachment size to download, in MB (0 = no limit). */
	maxAttachmentMB: number;
	/** Verbose console logging under the `[obs-gmail]` prefix. */
	debugLogging: boolean;
}

export interface ThreadEntry {
	threadId: string;
	vaultSubfolder: string;
	subject: string;
	messages: ThreadMessageRef[];
}

export interface ThreadMessageRef {
	id: string;
	notePath: string;
	from: string;
	receivedIso: string;
	subject: string;
	/** Lowercased participant emails (from + to + cc), for calendar linking. */
	people?: string[];
}

/** A single person on a message or event. */
export interface Person {
	name: string;
	email: string;
}

/** Normalized Gmail message — parsed from the raw MIME payload by GmailClient. */
export interface MailMessage {
	id: string;
	threadId: string;
	subject: string;
	from: Person;
	to: Person[];
	cc: Person[];
	/** ISO 8601 (UTC). Derived from internalDate, falling back to the Date header. */
	dateIso: string;
	snippet: string;
	bodyHtml?: string;
	bodyText?: string;
	labelIds: string[];
	hasAttachments: boolean;
	/** Deep link that opens the message in Gmail on the web. */
	webLink: string;
}

/** Attachment metadata discovered while walking a message's MIME parts. */
export interface MailAttachment {
	attachmentId: string;
	filename: string;
	mimeType: string;
	size: number;
}

export interface GmailLabel {
	id: string;
	name: string;
	type?: string;
}

/** Normalized Google Calendar event. */
export interface CalEvent {
	id: string;
	summary: string;
	description?: string;
	descriptionHtml?: string;
	/** ISO 8601 (UTC) for timed events; YYYY-MM-DD for all-day. */
	startIso: string;
	endIso: string;
	isAllDay: boolean;
	isCancelled: boolean;
	location: string;
	organizer: Person;
	attendees: Person[];
	hangoutLink: string;
	htmlLink: string;
}

/** Lightweight summary persisted for the Upcoming sidebar. */
export interface UpcomingEvent {
	id: string;
	/** Account displayName, for the sidebar badge when several accounts sync. */
	accountName?: string;
	subject: string;
	startIso: string;
	endIso: string;
	isAllDay: boolean;
	location: string;
	notePath: string | null;
	onlineUrl: string;
	webLink: string;
}

function makeId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `acct-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
	}
}

/**
 * Fills every missing account field with its default. Also the "new account"
 * factory: `normalizeAccount({ displayName: "Work" })`.
 */
export function normalizeAccount(a: Partial<AccountSettings>): AccountSettings {
	return {
		id: a.id || makeId(),
		displayName: a.displayName ?? "Account 1",
		emailAddress: a.emailAddress ?? null,
		targetFolder: a.targetFolder || "10-Mailbox/Gmail",
		labels: a.labels?.length
			? a.labels
			: [{ gmailLabel: "INBOX", vaultSubfolder: "Inbox", enabled: true }],
		syncSince: a.syncSince ?? "",
		syncCalendar: a.syncCalendar ?? false,
		calendarDaysAhead: a.calendarDaysAhead ?? 14,
		calendarSubfolder: a.calendarSubfolder ?? "Calendar",
		linkRelatedEmails: a.linkRelatedEmails ?? true,
		refreshToken: a.refreshToken ?? null,
		historyIds: a.historyIds ?? {},
		threads: a.threads ?? {},
		calendarNotes: a.calendarNotes ?? {},
		upcomingCache: a.upcomingCache ?? [],
		lastSync: a.lastSync ?? null,
	};
}

/**
 * Normalizes loaded data into the current shape. Pre-multi-account data kept
 * every account field (token, labels, folders, history, threads) at the top
 * level; those become `accounts[0]`, so existing users upgrade without
 * re-consenting or re-syncing. A fresh install (`{}`) yields one default,
 * unconnected account.
 */
export function migrateSettings(data: unknown): PluginSettings {
	const raw = (data ?? {}) as Partial<PluginSettings> & Partial<AccountSettings>;
	const accounts =
		Array.isArray(raw.accounts) && raw.accounts.length
			? raw.accounts.map((a) => normalizeAccount(a ?? {}))
			: [normalizeAccount(raw)];
	return {
		clientId: raw.clientId ?? "",
		clientSecret: raw.clientSecret ?? "",
		accounts,
		syncIntervalMinutes: raw.syncIntervalMinutes ?? 15,
		syncOnStartup: raw.syncOnStartup ?? true,
		downloadAttachments: raw.downloadAttachments ?? false,
		maxAttachmentMB: raw.maxAttachmentMB ?? 10,
		debugLogging: raw.debugLogging ?? false,
	};
}

export const GMAIL_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/calendar.readonly",
];
