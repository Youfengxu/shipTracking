# ship-tracker

Watches ships by MMSI via the free [aisstream.io](https://aisstream.io) WebSocket API.
Each ship has its own configurable zone. Alerts fire via **Pushover**, **Telegram**, and
an optional **webhook** for three events:

- 📡 **AIS turned on** — first position report received since tracker started
- 🟢 **Zone entry** — ship crosses into its defined radius
- 🔴 **Zone exit / departure** — ship crosses back out

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

Edit `ships.json` — one entry per ship:

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
    "mmsi": "987654321",
    "name": "RSS Intrepid",
    "zone": {
      "label": "Changi Naval Base",
      "lat": 1.3644,
      "lon": 104.0109,
      "radiusKm": 2
    }
  }
]
```

Each ship can have a **different zone** (different location and radius), or the same zone.
Remove the `"zone"` key entirely if you only want AIS-on alerts for a ship with no geofence.

> 💡 Find MMSI numbers in the MarineTraffic app: tap a ship → Details → MMSI
> 💡 Get coordinates by long-pressing a location in Google Maps

### 3. Fill in your .env

Open `.env` and fill in:

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

You should see startup logs listing each ship and its zone:
```
[...] Tracking 2 ship(s):
[...]   RSS Fearless (123456789) → zone "Sembawang Naval Base" radius 3 km
[...]   RSS Intrepid (987654321) → zone "Changi Naval Base" radius 2 km
[...] Connected. Sending subscription...
```

---

## Running with pm2

### Start

```bash
# Update the cwd path in ecosystem.config.js first, then:
mkdir -p logs
pm2 start ecosystem.config.js
```

### Useful commands

```bash
pm2 status                          # see if it's running
pm2 logs ship-tracker               # live log tail
pm2 logs ship-tracker --lines 100   # last 100 lines
pm2 restart ship-tracker            # restart after ships.json or .env changes
pm2 stop ship-tracker               # stop
```

### Survive reboots

```bash
pm2 startup      # follow the instruction it prints
pm2 save         # save current process list
```

---

## Telegram Group Setup

Alerts are sent to a Telegram group so multiple people can receive them.

**Step 1 — Create a bot**
- Open Telegram and search for `@BotFather`
- Send `/newbot`, follow the prompts
- Copy the token it gives you → `TG_TOKEN` in `.env`

**Step 2 — Create a group and add your bot**
- Create a new Telegram group (e.g. "Ship Alerts")
- Add your bot as a member
- Send any message in the group

**Step 3 — Get the group chat ID**
- Visit this URL in your browser (swap in your token):
  ```
  https://api.telegram.org/bot<TG_TOKEN>/getUpdates
  ```
- Find your group in the JSON — it will have `"type": "group"` and a **negative** ID:
  ```json
  "chat": { "id": -987654321, "type": "group" }
  ```
- Copy that negative number → `TG_CHAT_ID` in `.env`

**Step 4 — Invite people**
Anyone you add to the group will receive ship alerts automatically.

> ⚠️ **Supergroup gotcha**: If Telegram automatically upgrades your group to a supergroup,
> the chat ID changes to `-100987654321`. If alerts stop arriving, re-run `getUpdates`
> to get the updated ID and `pm2 restart ship-tracker`.

---

## How it works

1. Loads ship config from `ships.json` — each ship has its own zone.
2. Connects to `aisstream.io` via WebSocket, filtered to your MMSIs and bounding boxes.
3. On the **first position report** for a ship since startup → fires AIS-on alert.
4. On each subsequent report → checks if the ship is inside its zone radius (haversine distance).
5. **Zone entry**: fires when ship crosses into radius for the first time.
6. **Zone exit**: fires when ship moves back outside — signals a departure.
7. Auto-reconnects with exponential backoff if the connection drops.

> ⚠️ **AIS-on alert on restart**: Because the tracker has no persistent state, restarting
> it will re-fire the AIS-on alert for any ship already broadcasting. This is expected.

---

## Adding or changing ships

Edit `ships.json` and restart:

```bash
pm2 restart ship-tracker
```

No code changes needed.
