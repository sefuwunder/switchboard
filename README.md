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

## API

- `GET /api/channels` · `PATCH /api/channels/:id` (`enabled`, `mode`, `min_priority`, `poll_minutes`)
- `POST /api/channels/:id/poll` · `POST /api/channels/:id/snooze` (`minutes` or `clear:true`)
- `GET /api/channels/:id/connect` → connect URL when the service needs linking
- `GET|PATCH /api/settings` (`quiet_enabled`, `quiet_start`, `quiet_end`, `digest_minutes`, `urgent_breaks_quiet`)
- `GET /api/notifications` · `POST /api/notifications/:id/dismiss|snooze`
- `POST /api/test` — fire a test signal through the router
- `GET /api/events` — SSE stream of board events
