# Switchboard 🎛️

A personal notification patch bay. Services patch in as channels; you
modulate how they're allowed to reach you — per-channel routing mode,
priority fader, quiet hours, digest batching, and snooze — and the
modulated reminders stream out on a live line.

Built with [Bun](https://bun.sh) + SQLite. Zero npm dependencies.

The UI is Solarized (light by default, dark via the ◐ toggle — remembered
per browser). Each service gets its own logo on its card, and channel
controls plus the Master section tuck under foldable subsections so the
board stays quiet until you want to tune it.

## Channels

| Channel | Signal source | Needs |
|---|---|---|
| Gmail | Unread mail matching your filter (default: inbox, last 2 days, no promos/social) | Google OAuth — see below |
| Google Calendar | Events starting in the next 36h | Google OAuth — see below |
| ClickUp | Overdue / due-soon tasks on your list | Works out of the box (skill credential or `CLICKUP_TOKEN`) |
| Anytype | Open tasks from your local Anytype app | Pair via the patch bay card (desktop app must be running) |
| GitHub | Unread notifications (mentions, review requests, CI, releases) | `GITHUB_TOKEN` in `.env` — see below |

Each channel poll is a local call with a hard timeout; a failing
channel reports its error on its card without disturbing the others.

## Modulation

- **Patch in/out** — pull a channel's cable; its signals are dropped.
- **Routing mode** — `instant` (notify now), `digest` (batched), `muted`.
- **Priority fader** — minimum priority (`low → urgent`) that gets through.
- **Quiet hours** — default 22:00–07:00; instant signals wait for the digest.
  Urgent signals can break through (toggleable).
- **Digest** — low-priority and held signals bundle into one
  `📦 Digest` every N minutes (default 60).
- **Snooze** — per notification (30m) or per channel (15m/1h/4h).
- **Gmail filter** — set any Gmail search query on the Gmail card
  (e.g. `label:clients is:unread`, `in:inbox from:boss@co.com`) to watch
  a folder or label instead of the whole inbox. Applies on the next poll.

Reminders arrive live over SSE; the 🔔 button enables desktop notifications.

## Run it

```sh
bun start   # → http://localhost:3002
```

Copy `.env.example` to `.env` to set `CLICKUP_TOKEN` / `CLICKUP_LIST_ID`,
`GITHUB_TOKEN`, and the Google OAuth client
(optional — without a token the ClickUp skill credential is used).

## Google OAuth setup

The Gmail and Google Calendar channels talk to Google directly — no CLI
needed. You register your own OAuth client once, then the Connect button
on each card does a normal Google sign-in.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
   and create a project (any name, e.g. `switchboard`).
2. **APIs & Services → Library**: enable **Gmail API** and
   **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**: choose **External**,
   fill in the app name and your email. Under **Scopes** add
   `.../auth/gmail.readonly` and `.../auth/calendar.readonly`.
   Under **Test users**, add your Gmail address (while the app is in
   testing mode, only test users can sign in).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   type **Web application**. Under **Authorized redirect URIs** add:
   `http://127.0.0.1:3002/api/oauth/google/callback`
   (if you run Switchboard on another port, use that port instead, or set
   `GOOGLE_REDIRECT_URI` in `.env` and register the same value).
5. Copy the **Client ID** and **Client secret** into your `.env`:
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (see `.env.example`).
6. Restart Switchboard, open the Gmail or Calendar card, click **Connect**,
   and sign in with Google. One consent covers both channels.

Tokens are stored locally in `switchboard.db` and refreshed silently; if
Google ever rejects them the card flips back to NOT CONNECTED so you can
reconnect.

## GitHub setup

The GitHub channel polls your unread notifications via the REST API.

1. Create a **fine-grained personal access token** at
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Under **Repository access** choose "Public repositories" (or "All
   repositories" if you want private repo notifications too), then under
   **Permissions → Account permissions** grant **Notifications: Read-only**.
3. Copy the token into your `.env` as `GITHUB_TOKEN` (see `.env.example`)
   and restart Switchboard.

Mentions, review requests, assignments, and security alerts route as
**high** priority; everything else is normal. The API only lists unread
notifications, so marking one read on GitHub clears it from the next poll.
If the token is missing or revoked, the card shows NOT CONNECTED with a
link back to the token page.

## Anytype pairing

The Anytype channel reads open tasks from the Anytype desktop app's local
HTTP API (`http://127.0.0.1:31009` by default). The app must be running on
the same machine as the switchboard.

1. On the Anytype card, click **Connect Anytype**.
2. Click **1 · get pairing code** — a 4-digit code appears in Anytype.
3. Enter the code and click **2 · pair**.

Or paste an API key (Anytype → Settings → API Keys) instead of pairing.
The key is stored locally in `switchboard.db`; `ANYTYPE_API_KEY` in `.env`
overrides it, and `ANYTYPE_BASE_URL` changes the API address (e.g. for the
`anytype-cli` headless server on port `31012`).

A task that is **overdue or due today raises an urgent alert**: it goes out
instantly (red, breaks the digest and — if enabled — quiet hours), even
though the channel defaults to digest mode. A task that *becomes* due fires
a fresh alert; one that stays due doesn't re-alert every poll.

## API

- `GET /api/channels` · `PATCH /api/channels/:id` (`enabled`, `mode`, `min_priority`, `poll_minutes`)
- `POST /api/channels/:id/poll` · `POST /api/channels/:id/snooze` (`minutes` or `clear:true`)
- `GET /api/channels/:id/connect` → connect URL when the service needs linking
  (`pairing:true` for Anytype, which pairs in-app instead)
- `POST /api/channels/anytype/challenge` → `{ challenge_id }` (4-digit code shows in Anytype)
- `POST /api/channels/anytype/pair` (`challenge_id`, `code`) → stores the API key
- `POST /api/channels/anytype/key` (`key`) → verify + store a pasted API key
- `GET|PATCH /api/settings` (`quiet_enabled`, `quiet_start`, `quiet_end`, `digest_minutes`, `urgent_breaks_quiet`)
- `GET /api/notifications` (`limit`, `offset`, `q` — searchable archive, newest first; `total` included when searching or paging)
- `POST /api/notifications/:id/dismiss|snooze`
- `POST /api/test` — fire a test signal through the router
- `GET /api/events` — SSE stream of board events
