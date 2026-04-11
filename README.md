# ship-tracker

Watches ships by MMSI via the free [aisstream.io](https://aisstream.io) WebSocket API.
Each ship supports multiple configurable geo-fence zones. Alerts fire via **Telegram**,
**Pushover**, and an optional **webhook** for three events:

- 📡 **AIS turned on** — ship returns to signal after 30+ minutes of silence
- 🟢 **Zone entry** — ship crosses into a defined radius
- 🔴 **Zone exit / departure** — ship crosses back out

Ships and zones are managed by editing `ships.json` / `zones.json` directly — the tracker
hot-reloads both files without a restart. Optional **enhanced MMSI-change detection** alerts
you if a tracked ship appears to have changed its MMSI (matched by callsign, vessel name, or
MMSI prefix).

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

Reference a saved zone in `ships.json` by its key name. Both files are watched — changes apply
within ~500 ms without restarting.

### 4. Fill in your .env

```
AISSTREAM_KEY=your_key_here
TG_TOKEN=your_telegram_bot_token
TG_CHAT_ID=your_telegram_chat_id
PUSHOVER_TOKEN=your_pushover_app_token   # optional
PUSHOVER_USER=your_pushover_user_key     # optional
WEBHOOK_URL=https://your-endpoint.com    # optional
```

| Variable | Where to get it |
|---|---|
| `AISSTREAM_KEY` | Sign up free at https://aisstream.io |
| `TG_TOKEN` | Message @BotFather on Telegram → /newbot |
| `TG_CHAT_ID` | See Telegram Group Setup below |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | https://pushover.net — create a free app |
| `WEBHOOK_URL` | Your own endpoint, or leave blank to skip |

### 5. Run it

```bash
node tracker.js
```

Startup logs list each ship and its zones:
```
[...] Loaded 2 ship(s) from ships.json
[...] Connecting to aisstream.io — tracking 2 ship(s)
[...]   RSS Fearless (123456789) → "Sembawang Naval Base" r=3 km
[...]   987654321 (987654321) → AIS-on only
[...] Connected. Sending subscription...
[...] HTTP status API listening on http://127.0.0.1:3001/status
```

---

## Alert examples

Telegram alerts include **clickable coordinates** linking to Google Maps, and a
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

## Managing ships

Edit `ships.json` directly — changes are picked up within ~500 ms without any restart.
The WebSocket subscription is also automatically updated to reflect the new ship list.

Similarly, edit `zones.json` to add or modify named zones.

---

## OpenClaw integration

The tracker integrates with [OpenClaw](https://openclaw.ai) so you can manage ships and
query status via natural language or slash commands in your **Telegram group** — no SSH or
file editing needed.

### How it works

OpenClaw's gateway polls Telegram and routes messages to the agent. Two skills are
registered in `~/.openclaw/skills/`:

| Skill | Purpose |
|---|---|
| `ship-tracker` | Manage ships and zones; handles all `/` commands and `@dll_snoop_bot` mentions |
| `ais` | Query live vessel positions from the status API |

The `ship-tracker` skill's Python scripts edit `ships.json` and `zones.json` directly.
The file-watcher in `tracker.js` picks up the changes within ~500 ms — no pm2 restart.

### Trigger rules

The agent only responds to messages in the ship-tracking Telegram group that:
- Start with `/` (slash command)
- Mention `@dll_snoop_bot` or `@DLL_snoop` (natural language)

All other messages are silently ignored.

### Slash commands

| Command | Effect |
|---|---|
| `/addship <mmsi>` | Start tracking a ship by MMSI (name auto-populates from AIS) |
| `/addship <mmsi> <zone-label>` | Add with a saved zone |
| `/addship <name\|callsign> <zone-label>` | Add a zone to an existing tracked ship |
| `/removeship <mmsi>` | Stop tracking |
| `/updatemmsi <name> <newMmsi>` | Update MMSI without losing zones or config |
| `/setcallsign <name\|mmsi> <callsign>` | Set AIS callsign (enables MMSI-change detection) |
| `/setcallsign <name\|mmsi> clear` | Remove callsign |
| `/addaltname <name\|mmsi> <altName>` | Add an alternative broadcast name |
| `/addzone <lat> <lon> <radius> <label>` | Save a reusable named zone |
| `/listships` | List all tracked ships, zones, and callsigns |
| `/shipstatus` | Live positions of all tracked ships (AIS on/off, location, last seen) |
| `/help` | Show this command table |

### Natural language examples

Mention `@dll_snoop_bot` with a plain-English request:

```
@dll_snoop_bot track MMSI 525014092 in the Singapore Straits zone
@dll_snoop_bot where are the ships right now?
@dll_snoop_bot stop tracking KRI Bima Suci
@dll_snoop_bot add the Singapore Straits zone to RSS Fearless
```

The agent resolves ship names and callsigns with fuzzy matching — it will suggest close
matches if an exact name is not found, and will ask for clarification before acting when
required information is missing (e.g. an MMSI that cannot be inferred).

### Skill file locations

```
~/.openclaw/skills/ship-tracker/
├── SKILL.md                        # agent routing rules and command table
└── scripts/
    ├── add_ship.py                 # /addship
    ├── remove_ship.py              # /removeship
    ├── list_ships.py               # /listships
    ├── update_ship.py              # /updatemmsi, /setcallsign, /addaltname
    ├── add_zone.py                 # /addzone
    ├── ship_status.py              # single-ship lookup
    └── shipstatus.py               # /shipstatus (all ships via HTTP API)

~/.openclaw/skills/ais/
├── SKILL.md                        # query routing rules
└── scripts/
    └── query_vessels.sh            # fetch live vessel list from status API
```

> ⚠️ The skill scripts use hardcoded absolute paths (`~/coding/shipTracking/ships.json`).
> If you move the repo, update the paths in each script.

---

## HTTP status API

A lightweight HTTP server runs on `http://127.0.0.1:3001` (localhost only).

**`GET /status`** — returns last known position for all tracked ships that have been seen:

```json
{
  "123456789": {
    "name": "RSS Fearless",
    "lat": 1.4585,
    "lon": 103.8185,
    "ts": "2026-01-01T00:00:00.000Z",
    "insideZones": ["Sembawang Naval Base"]
  }
}
```

| Field | Description |
|---|---|
| `name` | Ship name (or MMSI if unnamed) |
| `lat` / `lon` | Last reported coordinates |
| `ts` | ISO timestamp of last position report |
| `insideZones` | Array of zone labels the ship is currently inside |

Ships that have never been seen since startup are not included in the response.

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

Alerts have a **1-hour cooldown** per MMSI pair to prevent spam.

When enhanced detection is active for any ship, the AIS subscription broadens to all
vessels within the tracked bounding boxes (instead of just tracked MMSIs), and also
subscribes to `ShipStaticData` messages.

---

## Auto-population of ship details

If a ship entry in `ships.json` has no `name` or no `callsign`, the tracker will
automatically fill those fields the first time a `ShipStaticData` message arrives for
that MMSI. A Telegram message confirms what was populated:

```
📋 Ship details auto-populated
🚢 MMSI 123456789
   Name: RSS Fearless
   Callsign: S9F
```

Naval prefixes (USS, HMS, HMAS, KRI, etc.) are preserved in uppercase when
formatting the display name from the raw AIS broadcast.

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

> ⚠️ **Supergroup gotcha**: If Telegram upgrades your group to a supergroup,
> the chat ID changes to `-100XXXXXXXXX`. Re-run `getUpdates` to get the new ID
> and update `.env`, then `pm2 restart ship-tracker`.

---

## How it works

1. **Startup** — loads `zones.json` then `ships.json`, builds bounding boxes from all zones,
   starts the WebSocket connection, starts the HTTP status API on port 3001.

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
   - For every *other* tracked ship with enhanced detection, checks if the broadcast
     name or callsign matches → fires MMSI-change alert if so.

6. **Hot-reload** — `fs.watch` on `ships.json` and `zones.json` triggers a reload + WebSocket
   reconnect within 500 ms of any file change.

7. **Reconnection** — exponential backoff (5 s → 60 s max) on WebSocket disconnect.

8. **Reverse geocoding** — all alert notifications call the Nominatim API to resolve lat/lon
   to a human-readable place name (sea, bay, city, or country). Timeout is 5 s; failures
   are silently skipped.

9. **Telegram formatting** — outbound alerts use HTML parse mode so coordinates render as
   tappable Google Maps links.
