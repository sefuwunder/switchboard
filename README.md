# Switchboard 🎛️

A personal notification patch bay. Services patch in as channels; you
modulate how they're allowed to reach you — per-channel routing mode,
priority fader, quiet hours, digest batching, and snooze — and the
modulated reminders stream out on a live line.

Built with [Bun](https://bun.sh) + SQLite. Zero npm dependencies.

## Channels

| Channel | Signal source | Needs |
|---|---|---|
| Gmail | Unread inbox mail (last 2 days, no promos/social) | Connect via the patch bay |
| Google Calendar | Events starting in the next 36h | Connect via the patch bay |
| ClickUp | Overdue / due-soon tasks on your list | Works out of the box (skill credential or `CLICKUP_TOKEN`) |
| Anytype | Open tasks from your local Anytype app | Pair via the patch bay card (desktop app must be running) |

Each channel poll is a local CLI call with a hard timeout; a failing
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

Reminders arrive live over SSE; the 🔔 button enables desktop notifications.

## Run it

```sh
bun start   # → http://localhost:3002
```

Copy `.env.example` to `.env` to set `CLICKUP_TOKEN` / `CLICKUP_LIST_ID`
(optional — without a token the ClickUp skill credential is used).

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

## API

- `GET /api/channels` · `PATCH /api/channels/:id` (`enabled`, `mode`, `min_priority`, `poll_minutes`)
- `POST /api/channels/:id/poll` · `POST /api/channels/:id/snooze` (`minutes` or `clear:true`)
- `GET /api/channels/:id/connect` → connect URL when the service needs linking
  (`pairing:true` for Anytype, which pairs in-app instead)
- `POST /api/channels/anytype/challenge` → `{ challenge_id }` (4-digit code shows in Anytype)
- `POST /api/channels/anytype/pair` (`challenge_id`, `code`) → stores the API key
- `POST /api/channels/anytype/key` (`key`) → verify + store a pasted API key
- `GET|PATCH /api/settings` (`quiet_enabled`, `quiet_start`, `quiet_end`, `digest_minutes`, `urgent_breaks_quiet`)
- `GET /api/notifications` · `POST /api/notifications/:id/dismiss|snooze`
- `POST /api/test` — fire a test signal through the router
- `GET /api/events` — SSE stream of board events
