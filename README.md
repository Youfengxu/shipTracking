# ship-tracker

Watches ships by MMSI via the free [aisstream.io](https://aisstream.io) WebSocket API.
Each ship supports multiple configurable geo-fence zones. Alerts fire via **Telegram**,
**Pushover**, and an optional **webhook** for three events:

- 📡 **AIS turned on** — ship returns to signal after 30+ minutes of silence
- 🟢 **Zone entry** — ship crosses into a defined radius
- 🔴 **Zone exit / departure** — ship crosses back out

Ships and zones are managed via **Telegram slash commands** (or by editing `ships.json` /
`zones.json` directly). The tracker hot-reloads both files without a restart. Optional
**enhanced MMSI-change detection** alerts you if a tracked ship appears to have changed
its MMSI (matched by callsign, vessel name, or MMSI prefix).

---

## Setup

### 1. Install dependencies

```bash
cd ~/coding/shipTracking
npm install
```

### 2. Configure your ships

Copy the example file and edit it:

```bash
cp ships.example.json ships.json
```

Edit `ships.json` — one entry per ship. All fields except `mmsi` are optional:

```json
[
  {
    "mmsi": "123456789",
    "name": "RSS Fearless",
    "callsign": "S9F",
    "zones": [
      {
        "label": "Sembawang Naval Base",
        "lat": 1.4585,
        "lon": 103.8185,
        "radiusKm": 3
      }
    ]
  },
  {
    "mmsi": "987654321"
  }
]
```

| Field | Description |
|---|---|
| `mmsi` | 9-digit MMSI (required) |
| `name` | Friendly display name — auto-populated from AIS if omitted |
| `callsign` | AIS callsign — auto-populated from AIS if omitted; enables MMSI-change detection |
| `altNames` | Array of alternative broadcast names for MMSI-change detection |
| `zones` | Array of geo-fence zones — omit for AIS-on alerts only |

> 💡 Find MMSIs in the MarineTraffic app: tap a ship → Details → MMSI  
> 💡 Get coordinates by long-pressing a location in Google Maps

### 3. Configure zones (optional)

Edit `zones.json` to define reusable named zones:

```json
{
  "Sembawang": {
    "label": "Sembawang Naval Base",
    "lat": 1.4585,
    "lon": 103.8185,
    "radiusKm": 3
  }
}
```

Reference a saved zone by its key name when using `/addzone`. Both files are watched —
changes apply within ~500 ms without restarting.

### 4. Fill in your .env

```
AISSTREAM_KEY=your_key_here
TG_TOKEN=your_telegram_bot_token
TG_CHAT_ID=your_telegram_chat_id
PUSHOVER_TOKEN=your_pushover_app_token   # optional
PUSHOVER_USER=your_pushover_user_key     # optional
WEBHOOK_URL=https://your-endpoint.com    # optional

# Beta: Ollama NL query (see below)
LLAMA_URL=http://127.0.0.1:11435         # optional
LLAMA_MODEL=llama3                       # optional
```

| Variable | Where to get it |
|---|---|
| `AISSTREAM_KEY` | Sign up free at https://aisstream.io |
| `TG_TOKEN` | Message @BotFather on Telegram → /newbot |
| `TG_CHAT_ID` | See Telegram Group Setup below |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | https://pushover.net — create a free app |
| `WEBHOOK_URL` | Your own endpoint, or leave blank to skip |
| `LLAMA_URL` | Base URL of a running Ollama instance (leave blank to disable NL) |
| `LLAMA_MODEL` | Ollama model to use for NL queries (default: `llama3`) |

### 5. Run it

```bash
node tracker.js
# or with auto-restart on file changes:
npm run dev
```

Startup logs list each ship and its zones:
```
[...] Loaded 2 ship(s) from ships.json
[...] Connecting to aisstream.io — tracking 2 ship(s)
[...]   RSS Fearless (123456789) → "Sembawang Naval Base" r=3 km
[...]   987654321 (987654321) → AIS-on only
[...] Connected. Sending subscription...
[...] HTTP status API listening on http://127.0.0.1:3001/status
[...] Telegram bot: @your_bot — polling for commands
```

---

## Telegram commands

The tracker polls Telegram continuously and handles all slash commands natively — no
external agent or proxy is needed. Send commands directly to the bot (private chat) or
in any group the bot is a member of.

### Status & lookup

| Command | Description |
|---|---|
| `/status` | Last known position of all tracked ships — online/dark indicator, age, active zones |
| `/ping <name or mmsi>` | Detailed status for one ship — coordinates, reverse-geocoded location, age |
| `/listships` | All tracked ships with their MMSIs and zones |
| `/listzones` | All named zones from `zones.json` with coordinates and radii |
| `/help` | Full command reference |

### Managing ships

| Command | Description |
|---|---|
| `/addship <mmsi> [name]` | Start tracking a new ship (name auto-fills from AIS) |
| `/removeship <name or mmsi>` | Stop tracking a ship |
| `/setname <mmsi> <name>` | Rename a tracked ship |
| `/setcallsign <ship> <callsign>` | Set AIS callsign; use `none` to clear |
| `/addaltname <ship> <alt>` | Add an alternate broadcast name for MMSI-change detection |
| `/rmaltname <ship> <alt>` | Remove an alternate broadcast name |
| `/undo` | Revert the last change to the ship list |

### Managing zones

| Command | Description |
|---|---|
| `/addzone <ship> <zone> [radiusKm]` | Add a named zone (from `/listzones`) to a ship |
| `/addzone <ship> <lat,lon,radius>` | Add an inline zone by raw coordinates |
| `/rmzone <ship> <zone>` | Remove a zone from a ship |

### MMSI-change suspects

| Command | Description |
|---|---|
| `/listsuspect` | Show all recorded suspect MMSIs (possible identity changes) |
| `/clearsuspect <mmsi>` | Remove a suspect MMSI from the list |

### Examples

```
/addship 368926114 USS Tulsa
/setcallsign "USS Tulsa" NFGP
/addaltname "USS Tulsa" TULSA
/addzone "USS Tulsa" "Singapore Straits"
/addzone "USS Tulsa" "Sembawang Naval Base" 3
/ping USS Tulsa
/rmzone "USS Tulsa" "Singapore Straits"
/removeship USS Tulsa
```

---

## Beta: Natural language via Ollama

When `LLAMA_URL` is set in `.env`, the bot accepts **plain-English messages** in addition
to slash commands. This works in:

- **Private chat** — any message to the bot is treated as a natural language query
- **Group chat** — messages that mention `@your_bot` are processed as NL queries

The bot sends the message to a local [Ollama](https://ollama.com) instance, which maps it
to one or more slash commands using a structured prompt that includes the current ship and
zone lists. The resolved commands are then executed normally.

**Examples:**

```
"Track MMSI 525014092 in the Singapore Straits zone"
"Where is RSS Fearless right now?"
"Stop tracking KRI Bima Suci"
"Rename RMN Warship 174 to Warship"
"Undo that"
```

> ⚠️ This feature requires a locally running Ollama instance. It adds ~90 s timeout per
> query and is intended for experimentation, not production use.

**Setup:**

1. Install [Ollama](https://ollama.com) and pull your chosen model: `ollama pull llama3`
2. Set `LLAMA_URL` and `LLAMA_MODEL` in `.env`
3. Send `SIGHUP` to reload without restarting: `kill -HUP $(pm2 pid ship-tracker)`

If the model is not found or Ollama returns an error, the bot replies with a descriptive
error message rather than silently failing.

---

## Alert examples

Telegram alerts include **clickable coordinates** linking to Google Maps and a
**reverse-geocoded location** (sea name, city, or region) when available.

**AIS turned on**
```
📡 AIS TURNED ON
🚢 RSS Fearless (MMSI 123456789)
🌐 1.4585, 103.8185   ← tappable link to Google Maps
📍 Johor Strait
🕐 Thu, 01 Jan 2026 00:00:00 GMT
```

**Zone entry**
```
🟢 ZONE ENTRY
🚢 RSS Fearless
📍 Entered: Sembawang Naval Base
🌐 1.4585, 103.8185 — 0.82 km from centre
📍 Singapore
🕐 Thu, 01 Jan 2026 00:00:00 GMT
```

**Zone exit**
```
🔴 ZONE EXIT / POSSIBLE DEPARTURE
🚢 RSS Fearless
📍 Left: Sembawang Naval Base
🌐 1.4585, 103.8185
📍 Johor Strait
🕐 Thu, 01 Jan 2026 00:00:00 GMT
```

**Possible MMSI change**
```
⚠️ POSSIBLE MMSI CHANGE
🚢 RSS Fearless (tracked MMSI 123456789)
📡 Spotted MMSI: 123456799 (callsign "S9F")
🌐 1.4585, 103.8185
📍 Singapore
🕐 Thu, 01 Jan 2026 00:00:00 GMT
```

---

## HTTP status API

A lightweight HTTP server runs on `http://127.0.0.1:3001` (localhost only).

**`GET /status`** — returns last known state for all tracked ships:

```json
{
  "123456789": {
    "name": "RSS Fearless",
    "lat": 1.4585,
    "lon": 103.8185,
    "ts": "2026-01-01T00:00:00.000Z",
    "insideZones": ["Sembawang Naval Base"],
    "hasBroadcast": true,
    "isOnline": true
  }
}
```

| Field | Description |
|---|---|
| `name` | Ship name (or MMSI if unnamed) |
| `lat` / `lon` | Last reported coordinates |
| `ts` | ISO timestamp of last position report |
| `insideZones` | Zone labels the ship is currently inside |
| `hasBroadcast` | Whether the ship has been seen at all since startup |
| `isOnline` | `true` if a position was received within the last 30 minutes |

Ships that have never been seen since startup are included with `null` position fields.

---

## State persistence

The tracker saves position and zone state to `state.json` every 5 seconds (throttled).
On restart, this file is loaded so that `/status` and `/ping` show last-known positions
immediately without waiting for fresh AIS data, and zone-entry state is preserved across
restarts to avoid spurious entry/exit alerts.

`state.json` is managed automatically — do not edit it manually.

---

## Enhanced MMSI-change detection

Some vessels (particularly military and government ships) occasionally transmit under
a different MMSI. Enable per-ship detection by setting `callsign` and/or `altNames` in
`ships.json`.

Once enabled, the tracker watches for:

1. **Callsign / name match** — a `ShipStaticData` message from an unknown MMSI that
   matches the ship's callsign, name, or any alt name
2. **MMSI prefix proximity** — an unknown MMSI sharing the same 3-digit country prefix
   appearing inside the ship's zone

Alerts have a **1-hour cooldown** per MMSI pair to prevent spam. Suspects are recorded
in `suspects.json` and viewable with `/listsuspect`.

When enhanced detection is active for any ship, the AIS subscription broadens to all
vessels within the tracked bounding boxes (instead of just tracked MMSIs) and also
subscribes to `ShipStaticData` messages.

---

## Auto-population of ship details

If a ship entry in `ships.json` has no `name` or no `callsign`, the tracker automatically
fills those fields the first time a `ShipStaticData` message arrives for that MMSI. A
Telegram message confirms what was populated:

```
📋 Ship details auto-populated
🚢 MMSI 123456789
   Name: RSS Fearless
   Callsign: S9F
```

Naval prefixes (USS, HMS, HMAS, KRI, etc.) are preserved in uppercase when formatting
the display name from the raw AIS broadcast.

---

## AIS-on detection

A ship is considered "off" when no position report has been received for **30 minutes**
(`STALE_MS`). The first position report after that silence triggers the AIS-on alert.

To avoid spurious alerts immediately after the tracker starts or restarts, there is a
**5-minute startup grace period** (`STARTUP_GRACE_MS`) during which AIS-on alerts are
suppressed. This prevents every currently-broadcasting ship from firing an alert on boot.

---

## Running with pm2

### Start

```bash
mkdir -p logs
pm2 start ecosystem.config.js
```

### Useful commands

```bash
pm2 status                          # see if it's running
pm2 logs ship-tracker               # live log tail
pm2 logs ship-tracker --lines 100   # last 100 lines
pm2 restart ship-tracker            # restart after .env changes
pm2 stop ship-tracker               # stop
```

### Reload .env without restarting

Send `SIGHUP` to reload environment variables (including `LLAMA_URL` / `LLAMA_MODEL`)
without interrupting the WebSocket connection:

```bash
kill -HUP $(pm2 pid ship-tracker)
```

### Survive reboots

```bash
pm2 startup      # follow the instruction it prints
pm2 save         # save current process list
```

---

## Telegram Group Setup

**Step 1 — Create a bot**
- Open Telegram and search for `@BotFather`
- Send `/newbot`, follow the prompts
- Copy the token → `TG_TOKEN` in `.env`

**Step 2 — Create a group and add your bot**
- Create a new Telegram group (e.g. "Ship Alerts")
- Add your bot as a member
- Send any message in the group

**Step 3 — Get the group chat ID**
- Visit: `https://api.telegram.org/bot<TG_TOKEN>/getUpdates`
- Find `"type": "group"` in the JSON — copy the negative `"id"` value
- Paste it as `TG_CHAT_ID` in `.env`

**Step 4 — Invite people**
Anyone in the group receives alerts.

> ⚠️ **Supergroup gotcha**: If Telegram upgrades your group to a supergroup, the chat ID
> changes to `-100XXXXXXXXX`. Re-run `getUpdates` to get the new ID and update `.env`,
> then `pm2 restart ship-tracker`.

---

## OpenClaw integration (optional)

The tracker optionally integrates with [OpenClaw](https://openclaw.ai) as an external
agent layer. OpenClaw's gateway routes messages to Python skill scripts that edit
`ships.json` and `zones.json` directly; the file-watcher in `tracker.js` picks up
changes within ~500 ms.

This integration is separate from the native Telegram command handling built into
`tracker.js` — both can coexist. OpenClaw is primarily useful if you want more
sophisticated agent reasoning, multi-step confirmation flows, or fuzzy name matching
beyond what the built-in Llama NL mode provides.

Skill files live in `~/.openclaw/skills/ship-tracker/` and `~/.openclaw/skills/ais/`.

> ⚠️ The skill scripts use hardcoded absolute paths (`~/coding/shipTracking/ships.json`).
> If you move the repo, update the paths in each script.

---

## How it works

1. **Startup** — loads `zones.json` then `ships.json`, builds bounding boxes from all
   zones, starts the WebSocket connection, starts the HTTP status API on port 3001, and
   begins polling Telegram for commands.

2. **WebSocket subscription** — subscribes to [aisstream.io](https://aisstream.io):
   - Default (no enhanced tracking): filtered to tracked MMSIs, `PositionReport` only.
   - Enhanced tracking active: all vessels in bounding boxes + `ShipStaticData` messages.

3. **PositionReport received for a tracked MMSI:**
   - Updates `lastPosition` map with current coords and timestamp.
   - If the ship was "off" (no report for 30+ min) and startup grace period has elapsed →
     fires AIS-on alert with reverse-geocoded location and clickable coords.
   - Runs haversine distance check against each of the ship's zones.
   - Zone entry/exit transitions fire the corresponding alert.

4. **PositionReport from unknown MMSI** (enhanced mode only):
   - Checks if the unknown MMSI shares a 3-digit country prefix with any enhanced-tracked ship.
   - If that unknown vessel is inside one of the ship's zones → fires MMSI-change alert.

5. **ShipStaticData from any MMSI** (enhanced mode only):
   - Auto-populates `name` / `callsign` for the matching tracked ship if those fields are empty.
   - For every other tracked ship with enhanced detection, checks if the broadcast
     name or callsign matches → fires MMSI-change alert if so.

6. **Hot-reload** — `fs.watch` on `ships.json` and `zones.json` triggers a reload +
   WebSocket reconnect within 500 ms of any file change.

7. **Reconnection** — exponential backoff (5 s → 60 s max) on WebSocket disconnect.
   A keepalive ping fires every 30 s to detect silent drops.

8. **Reverse geocoding** — all alert notifications call the Nominatim API to resolve
   lat/lon to a human-readable place name (sea, bay, city, or country). Timeout is 5 s;
   failures are silently skipped.

9. **Telegram polling** — long-polls `getUpdates` with a 30 s timeout. Slash commands
   are dispatched directly; plain-English messages in private chats or bot-mention
   messages in groups are routed to Ollama (if configured).

10. **State persistence** — `state.json` is written every 5 s (throttled) and loaded on
    startup so positions and zone membership survive restarts.

---

## File reference

| File | Purpose |
|---|---|
| `tracker.js` | Main process — AIS WebSocket, Telegram polling, alerts |
| `ships.json` | List of tracked ships (hot-reloaded) |
| `zones.json` | Named geo-fence zones (hot-reloaded) |
| `state.json` | Auto-saved position and zone state (do not edit manually) |
| `suspects.json` | Auto-saved MMSI-change suspects |
| `.env` | Secrets and configuration |
| `ecosystem.config.js` | pm2 process definition |
| `eslint.config.mjs` | ESLint flat config (dev) |
