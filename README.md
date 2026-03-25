# ship-tracker

Watches two ships by MMSI via the free [aisstream.io](https://aisstream.io) WebSocket API.
Fires a notification to **Pushover**, **Telegram**, and an optional **webhook** whenever
either ship enters or exits a configurable geofence radius.

---

## Setup

### 1. Install dependencies

```bash
cd ~/coding/shipTracking
npm install
```

### 2. Fill in your .env

Open `.env` and fill in every value:

| Variable | Where to get it |
|---|---|
| `AISSTREAM_KEY` | Sign up free at https://aisstream.io |
| `TARGET_MMSIS` | Open MarineTraffic app → tap a ship → Details → MMSI |
| `ZONE_LAT` / `ZONE_LON` | Coordinates of your target location (e.g. Google Maps long-press) |
| `ZONE_RADIUS_KM` | How close the ship needs to get to trigger an alert |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | https://pushover.net — create a free app |
| `TG_TOKEN` | Message @BotFather on Telegram → /newbot |
| `TG_CHAT_ID` | See Telegram Group Setup section below |
| `WEBHOOK_URL` | Your own endpoint, or leave blank to skip |

### 3. Test it manually first

```bash
node tracker.js
```

You should see log lines like:
```
[2025-03-25T10:00:00.000Z] Connecting to aisstream.io — tracking MMSIs: 123456789, 987654321
[2025-03-25T10:00:01.000Z] Connected. Sending subscription...
```

If a tracked ship is at sea near your bounding box, position reports will start appearing.

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
pm2 status                   # see if it's running
pm2 logs ship-tracker        # live log tail
pm2 logs ship-tracker --lines 100   # last 100 lines
pm2 restart ship-tracker     # restart after .env changes
pm2 stop ship-tracker        # stop
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

> ⚠️ **Supergroup gotcha**: If Telegram automatically upgrades your group to a supergroup
> (happens when you enable certain features), the chat ID format changes to `-100987654321`.
> If alerts stop arriving, re-run `getUpdates` to get the updated ID and restart the tracker.

---

## How it works

1. Opens a WebSocket to `aisstream.io` filtered to your 2 MMSIs and a bounding box
   around your zone.
2. For every incoming position report, calculates the real distance (haversine) from
   your zone centre.
3. On **entry** (ship crosses inside radius): fires Pushover + Telegram + webhook.
4. On **exit** (ship crosses back outside): fires again.
5. Auto-reconnects with exponential backoff if the connection drops.

---

## Adjusting the zone

Edit `.env` — no code changes needed:

```
ZONE_LAT=1.264
ZONE_LON=103.822
ZONE_RADIUS_KM=5
```

Then `pm2 restart ship-tracker`.
