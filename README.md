# ship-tracker

Watches ships by MMSI via the free [aisstream.io](https://aisstream.io) WebSocket API.
Each ship supports multiple configurable geo-fence zones. Alerts fire via **Telegram**,
**Pushover**, and an optional **webhook** for three events:

- 📡 **AIS turned on** — first position report received since tracker started
- 🟢 **Zone entry** — ship crosses into a defined radius
- 🔴 **Zone exit / departure** — ship crosses back out

Ships and zones can be managed live via **Telegram commands** — no restart needed.
Optional **enhanced MMSI-change detection** alerts you if a tracked ship appears to
have changed its MMSI (matched by callsign, vessel name, or MMSI prefix).

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

- Omit `"name"` → notifications show MMSI instead
- Omit `"zones"` → only AIS-on alerts fire, no geofence
- Each ship can have **multiple zones** (different locations and radii)
- Add `"callsign"` and/or `"altNames"` to enable enhanced MMSI-change detection

> 💡 Find MMSIs in the MarineTraffic app: tap a ship → Details → MMSI  
> 💡 Get coordinates by long-pressing a location in Google Maps

### 3. Fill in your .env

| Variable | Where to get it |
|---|---|
| `AISSTREAM_KEY` | Sign up free at https://aisstream.io |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | https://pushover.net — create a free app |
| `TG_TOKEN` | Message @BotFather on Telegram → /newbot |
| `TG_CHAT_ID` | See Telegram Group Setup section below |
| `WEBHOOK_URL` | Your own endpoint, or leave blank to skip |

### 4. Test it manually first

```bash
node tracker.js
```

Startup logs will list each ship and its zone:
```
[...] Tracking 2 ship(s):
[...]   RSS Fearless (123456789) → "Sembawang Naval Base" r=3 km
[...]   987654321 (987654321) → AIS-on only
[...] Connected. Sending subscription...
```

---

## Telegram commands

Manage ships live by sending commands to your Telegram group.
The bot polls for commands every **2.5 seconds**.

Send `/help` to the bot at any time to see all commands.

### /addship

Add a new ship, or add a zone to an existing ship by name:

```
/addship <mmsi>
/addship <mmsi> <name>
/addship <mmsi> <name> <lat> <lon> <radiusKm> [zoneLabel]
/addship <mmsi> <name> <savedZoneLabel>
/addship <name> <lat> <lon> <radiusKm> [zoneLabel]
/addship <name> <savedZoneLabel>
```

| Example | Effect |
|---|---|
| `/addship 123456789` | Track by MMSI only, no name, no zone |
| `/addship 123456789 RSS Fearless` | Add with friendly name, no zone |
| `/addship 123456789 RSS Fearless 1.4585 103.8185 3` | Add with name and zone |
| `/addship 123456789 RSS Fearless 1.4585 103.8185 3 Sembawang` | Full config with zone label |
| `/addship RSS Fearless Sembawang` | Add a saved zone to an existing ship |

### /removeship

```
/removeship <mmsi>
```

Removes the ship from tracking immediately.

### /updatemmsi

```
/updatemmsi <name> <newMmsi>
```

Updates the MMSI for an existing ship without losing its zones or configuration.
Useful when a vessel's MMSI changes and you've confirmed the new one.

### /addzone

```
/addzone <lat> <lon> <radiusKm> <zoneLabel>
```

Saves a named zone for reuse with `/addship`. Example:

```
/addzone 1.4585 103.8185 3 Sembawang Naval Base
```

### /setcallsign

```
/setcallsign <name_or_mmsi> <callsign>
/setcallsign <name_or_mmsi> clear
```

Sets the AIS callsign for a ship. Enables enhanced MMSI-change detection — if any
vessel broadcasts this callsign from a different MMSI, you'll get an alert.

### /addaltname

```
/addaltname <name_or_mmsi> <altName>
```

Adds an alternative broadcast name for a ship (e.g. `TULSA` for a ship named `USS Tulsa`).
Used for name-based MMSI-change detection alongside `/setcallsign`.

### /listships

```
/listships
```

Lists all tracked ships with their MMSIs, AIS status, callsigns, alt names, and zones.

### /help

```
/help
```

Shows all available commands and their syntax.

---

## Enhanced MMSI-change detection

Some vessels (particularly military and government ships) occasionally transmit under
a different MMSI. Enable per-ship detection with `/setcallsign` and/or `/addaltname`.

Once enabled, the tracker watches for:

1. **Callsign / name match** — a `ShipStaticData` message from an unknown MMSI that
   matches the ship's callsign, name, or any alt name
2. **MMSI prefix proximity** — an unknown MMSI sharing the same 3-digit country prefix
   appearing inside the ship's zone

Alert format:
```
⚠️ POSSIBLE MMSI CHANGE
🚢 RSS Fearless (tracked MMSI 123456789)
📡 Spotted MMSI: 123456799 (callsign "S9F")
🌐 1.4585, 103.8185
🕐 Thu, 01 Jan 2026 00:00:00 GMT
```

Alerts have a **1-hour cooldown** per MMSI pair to prevent spam.

When enhanced detection is active for any ship, the subscription to aisstream.io
broadens to all vessels within the tracked zones (instead of just tracked MMSIs),
and also subscribes to `ShipStaticData` messages.

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
Anyone in the group receives alerts. Anyone can also send bot commands.

> ⚠️ **Supergroup gotcha**: If Telegram upgrades your group to a supergroup,
> the chat ID changes to `-100XXXXXXXXX`. Re-run `getUpdates` to get the new ID
> and update `.env`, then `pm2 restart ship-tracker`.

---

## How it works

1. Loads `zones.json` and `ships.json` on startup.
2. Connects to `aisstream.io` via persistent WebSocket.
   - Default: filtered to tracked MMSIs, `PositionReport` messages only.
   - When any ship has enhanced tracking active: all vessels in bounding boxes,
     plus `ShipStaticData` messages.
3. **First position report** for a tracked ship → fires AIS-on alert.
4. Each subsequent report → haversine distance check against all of that ship's zones.
5. **Zone entry / exit** → fires alert on transition.
6. **ShipStaticData from unknown MMSI** → name/callsign match check (enhanced mode).
7. **PositionReport from unknown same-prefix MMSI inside a zone** → MMSI-change alert.
8. **Telegram polling** runs every 2.5s in parallel — processes commands, updates
   `ships.json`/`zones.json`, and reconnects the WebSocket with the new subscription.
9. Auto-reconnects with exponential backoff on disconnect.

> ⚠️ **AIS-on alert on restart**: Restarting the tracker re-fires the AIS-on alert
> for any ship already broadcasting. This is expected.

---

## Adding or changing ships

Preferred: use Telegram commands — live, no restart needed.

Alternatively, edit `ships.json` directly and run:
```bash
pm2 restart ship-tracker
```
