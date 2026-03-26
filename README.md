# ship-tracker

Watches ships by MMSI via the free [aisstream.io](https://aisstream.io) WebSocket API.
Each ship has its own configurable zone. Alerts fire via **Pushover**, **Telegram**, and
an optional **webhook** for three events:

- 📡 **AIS turned on** — first position report received since tracker started
- 🟢 **Zone entry** — ship crosses into its defined radius
- 🔴 **Zone exit / departure** — ship crosses back out

Ships can be managed live via **Telegram commands** — no restart needed.

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
    "zone": {
      "label": "Sembawang Naval Base",
      "lat": 1.4585,
      "lon": 103.8185,
      "radiusKm": 3
    }
  },
  {
    "mmsi": "987654321"
  }
]
```

- Omit `"name"` → notifications show MMSI instead
- Omit `"zone"` → only AIS-on alerts fire, no geofence
- Each ship can have a **different zone** (different location and radius)

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

You can manage ships live by sending commands to your Telegram group.
The bot polls for commands every **2.5 seconds**.

### /addship

```
/addship <mmsi>
/addship <mmsi> <name>
/addship <mmsi> <name> <lat> <lon> <radiusKm>
/addship <mmsi> <name> <lat> <lon> <radiusKm> <zoneLabel>
```

All arguments after the MMSI are optional:

| Example | Effect |
|---|---|
| `/addship 123456789` | Track by MMSI only, no name, no zone |
| `/addship 123456789 RSS Fearless` | Add with friendly name, no zone |
| `/addship 123456789 RSS Fearless 1.4585 103.8185 3` | Add with name and zone (label defaults to "Zone") |
| `/addship 123456789 RSS Fearless 1.4585 103.8185 3 Sembawang Naval Base` | Full config |

The new ship is tracked **immediately** — no restart needed.

### /removeship

```
/removeship <mmsi>
```

Removes the ship from tracking immediately.

### /listships

```
/listships
```

Shows all currently tracked ships with their zones.

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
pm2 restart ship-tracker            # restart (only needed after .env changes)
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

1. Loads `ships.json` on startup.
2. Connects to `aisstream.io` via persistent WebSocket, filtered to tracked MMSIs.
3. **First position report** for any ship → fires AIS-on alert.
4. Each subsequent report → haversine distance check against that ship's zone.
5. **Zone entry / exit** → fires alert on transition.
6. **Telegram polling** runs every 2.5s in parallel — processes `/addship`, `/removeship`,
   `/listships` commands. On add/remove, `ships.json` is updated and the WebSocket
   reconnects with the new subscription immediately.
7. Auto-reconnects with exponential backoff on disconnect.

> ⚠️ **AIS-on alert on restart**: Restarting the tracker re-fires the AIS-on alert
> for any ship already broadcasting. This is expected.

---

## Adding or changing ships

Preferred: use `/addship` or `/removeship` in Telegram — live, no restart.

Alternatively, edit `ships.json` directly and run:
```bash
pm2 restart ship-tracker
```
