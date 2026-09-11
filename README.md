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
| Google Calendar | Events starting in the next 36h | Secret iCal URL — see below |
| ClickUp | Overdue / due-soon tasks on your list | Works out of the box (skill credential or `CLICKUP_TOKEN`) |
| Anytype | Open tasks from your local Anytype app | Pair via the patch bay card (desktop app must be running) |
| GitHub | Unread notifications (mentions, review requests, CI) + repo activity (pushes, issues, PRs, releases, stars) | `GITHUB_TOKEN` in `.env` — see below |

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
- **Starred** — tap ☆ on any reminder to pin it in the Starred section,
  where it stays until unstarred. Star from the feed or the archive.

Reminders arrive live over SSE; the 🔔 button enables desktop notifications.

## Run it

```sh
bun start   # → http://localhost:3002
```

Copy `.env.example` to `.env` to set `CLICKUP_TOKEN` / `CLICKUP_LIST_ID`
and `GITHUB_TOKEN`
(optional — without a token the ClickUp skill credential is used).

## Calendar setup (iCal)

The Calendar channel reads your calendar through its secret iCal feed —
no OAuth, no API keys on Google's side.

1. Open [Google Calendar](https://calendar.google.com/) → **Settings**
   (gear icon) → pick your calendar in the left sidebar.
2. Scroll to **Integrate calendar** and copy the
   **Secret address in iCal format** (ends in `/basic.ics`).
3. In Switchboard, expand the **Google Calendar** card and paste the URL
   into the **iCal feed** field. The card polls immediately.

Events starting in the next 36 hours surface as reminders (high priority
if starting within the hour), including recurring events. Keep the URL
private — anyone with it can read your calendar.

## GitHub setup

The GitHub channel polls two feeds via the REST API:

- **Notifications** — your unread inbox (mentions, review requests,
  assignments, security alerts). Mentions, review requests, assignments,
  and security alerts route as **high** priority; everything else is
  normal. The API only lists unread notifications, so marking one read on
  GitHub clears it from the next poll.
- **Repo activity** — pushes, issues, PRs, releases, and stars on your
  10 most recently pushed repos. Releases route as **high**, pushes /
  issues / PRs as **normal**, stars and forks as **low**. Push
  notifications list the commit messages (up to 3, truncated).

1. Create a **fine-grained personal access token** at
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Under **Repository access** choose "Public repositories" (or "All
   repositories" if you want private repo activity too), then under
   **Permissions → Account permissions** grant **Notifications: Read-only**.
3. Copy the token into your `.env` as `GITHUB_TOKEN` (see `.env.example`)
   and restart Switchboard.

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
- `GET /api/notifications` (`limit`, `offset`, `q` — searchable archive, newest first; `starred=1` — only pinned reminders; `total` included when searching, paging, or filtering starred)
- `POST /api/notifications/:id/dismiss|snooze|star` (`star` toggles unless given `{ "starred": true|false }`)
- `POST /api/test` — fire a test signal through the router
- `GET /api/events` — SSE stream of board events
