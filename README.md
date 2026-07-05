# Gmail Mailbox — Obsidian plugin

Sync Gmail into your Obsidian vault as **one note per email** plus a **per-label thread index**, and mirror your **Google Calendar** into an *Upcoming meetings* sidebar with one note per event (auto-linked to related emails).

Built as a sibling to the Outlook Mailbox plugin and shares its design: incremental sync, PKCE auth, always-on progress logging, per-request timeouts, per-item resilience, and a cooperative Stop.

## What it does

- One Markdown note per email under `10-Mailbox/Gmail/<Subfolder>/` (configurable), with YAML frontmatter (from, to, cc, date, labels, thread id, web link).
- A regenerated `_Thread Index.md` per label grouping messages by conversation.
- Incremental sync via Gmail's `history.list` — only changes since the last run. First run enumerates the whole label (optionally filtered by a start date).
- Google Calendar: a rolling 14-day (configurable) upcoming window, one note per event, an *Upcoming meetings* sidebar, and cross-links from meetings to related emails (shared attendees + subject).
- Optional attachment download with a size cap.

## One-time Google Cloud setup

You need a Google Cloud OAuth client. It's free.

1. **Create/select a project** at <https://console.cloud.google.com/>.
2. **Enable the APIs**: APIs & Services → Library → enable **Gmail API** and **Google Calendar API**.
3. **Configure the consent screen / audience** (in newer consoles this is **Google Auth Platform → Audience**; in older ones **APIs & Services → OAuth consent screen**):
   - **User type / Audience → External.** If it's set to **Internal**, sign-in fails with `Error 403: org_internal` for any account outside your Google Workspace organization — switch it to External. (A personal Gmail-owned project is External-only, so you may not see this choice.)
   - Fill in the app name and support email.
   - **Publishing status → Testing** (leave it here — no Google verification needed while testing).
   - **Test users → + Add users →** add every Google address you'll sign in with (e.g. your own Gmail). Only listed test users can authorize the app in Testing mode; up to 100 are allowed.
   - On first sign-in you'll see a **"Google hasn't verified this app"** screen — that's expected for an unverified test app. Click **Advanced → Go to \<app\> (unsafe)** to continue.
4. **Create the client**: APIs & Services → Credentials → **Create credentials → OAuth client ID → Application type: Desktop app**.
   - This is important: pick **Desktop app**, *not* Web application. The Desktop type accepts loopback (`http://127.0.0.1:<port>`) redirects without registering a port.
5. Copy the **Client ID** and **Client secret** from the dialog into the plugin's settings.
   - Google's Desktop-app "client secret" is **not** confidential (it ships inside every installed app). Google's token endpoint still requires it even under PKCE, which is why the plugin has a field for it.

Then in Obsidian: **Settings → Gmail Mailbox → Connect**. A browser tab opens for consent; approve and return to Obsidian.

## Scopes requested

- `https://www.googleapis.com/auth/gmail.readonly` — read mail.
- `https://www.googleapis.com/auth/calendar.readonly` — read calendar.

Read-only. The plugin never modifies your mailbox or calendar.

## Install (from source)

```bash
npm install
npm run build
VAULT="/path/to/your/vault" npm run install:vault
```

Then enable **Gmail Mailbox** under Settings → Community plugins.

## How incremental sync works

- On the **first** sync of a label, the plugin captures the mailbox `historyId`, then lists every message id in the label (`messages.list`, paginated) and writes a note for each. The captured `historyId` becomes the cursor.
- On **later** syncs it calls `history.list?startHistoryId=<cursor>&labelId=<id>` and only fetches messages that were **added** to (or newly labelled with) that label; removals and label-removals trash the corresponding notes.
- Gmail expires a history cursor after roughly a week of inactivity and returns **404**. The plugin catches that, drops the cursor, and transparently re-enumerates the whole label — no error surfaced. (This is the Gmail analog of Microsoft Graph's 410-on-stale-delta-token.)

Use **Settings → Maintenance → Reset sync state** to force a clean full re-enumeration.

## Stopping a sync

Hit **Stop** in Settings → Maintenance, or run the *Gmail Mailbox: Stop sync* command. The sync unwinds at the next message/page checkpoint. The interrupted label's history cursor is deliberately **not** advanced, so the next sync re-fetches whatever was missed — no silently-skipped mail.

## Security note

The OAuth **refresh token** and your **client secret** are stored in the plugin's `data.json` inside your vault, in plain text (same as the Outlook plugin). They are not encrypted at rest. Anyone with read access to your vault files can read them. Keep your vault private; revoke access anytime at <https://myaccount.google.com/permissions>.

## Troubleshooting

- **"Sync running but nothing happens"** — open the developer console (Ctrl/Cmd-Shift-I) and watch for `[obs-gmail]` lines. Baseline progress (label start/finish, page counts, summary) always prints, regardless of the Debug toggle.
- **`access_denied` / app not verified** — add your address as a Test user on the OAuth consent screen.
- **`invalid_client`** — the Client ID/secret don't match, or the client isn't a Desktop-app type.
- **Calendar empty after enabling** — click **Reconnect** to re-consent with the calendar scope.
