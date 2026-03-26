require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────
//
// Ships are defined in ships.json. Each entry looks like:
//
//   {
//     "mmsi": "123456789",
//     "name": "RSS Fearless",          // friendly label for notifications
//     "zone": {
//       "label": "Sembawang Naval Base",
//       "lat": 1.4585,
//       "lon": 103.8185,
//       "radiusKm": 3
//     }
//   }
//
// A ship with no "zone" key will still trigger an AIS-on alert, but no
// entry/exit zone alerts will fire for it.

const AISSTREAM_KEY = process.env.AISSTREAM_KEY;

let SHIPS;
try {
  SHIPS = require('./ships.json');
} catch {
  console.error('ERROR: ships.json not found. Copy ships.example.json to ships.json and fill it in.');
  process.exit(1);
}

if (!Array.isArray(SHIPS) || SHIPS.length === 0) {
  console.error('ERROR: ships.json must be a non-empty array.');
  process.exit(1);
}

const TARGET_MMSIS = SHIPS.map(s => String(s.mmsi));

// Build a lookup map: mmsi → ship config
const SHIP_MAP = {};
for (const ship of SHIPS) {
  SHIP_MAP[String(ship.mmsi)] = ship;
}

// Build bounding boxes — one per ship zone (aisstream deduplicates overlaps)
// ±1 degree is the coarse pre-filter; haversine handles actual precision.
const BBOX = SHIPS
  .filter(s => s.zone)
  .map(s => [
    [s.zone.lat - 1, s.zone.lon - 1],
    [s.zone.lat + 1, s.zone.lon + 1],
  ]);

// Fallback to global box if no zones defined
const BOUNDING_BOXES = BBOX.length > 0 ? BBOX : [[[-90, -180], [90, 180]]];

// ── State ─────────────────────────────────────────────────────────────────────

// Key format: "mmsi::zoneLabel" — tracks which ships are inside which zones
const insideZone = new Set();

// Tracks which MMSIs have been seen since startup (for AIS-on detection)
const seenMmsis = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Notifications ─────────────────────────────────────────────────────────────

async function sendPushover(text) {
  if (!process.env.PUSHOVER_TOKEN || !process.env.PUSHOVER_USER) return;
  try {
    await axios.post('https://api.pushover.net/1/messages.json', {
      token:   process.env.PUSHOVER_TOKEN,
      user:    process.env.PUSHOVER_USER,
      title:   '🚢 Ship Alert',
      message: text,
    });
    log('Pushover sent');
  } catch (err) {
    log(`Pushover error: ${err.message}`);
  }
}

async function sendTelegram(text) {
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,
      { chat_id: process.env.TG_CHAT_ID, text }
    );
    log('Telegram sent');
  } catch (err) {
    log(`Telegram error: ${err.message}`);
  }
}

async function sendWebhook(payload) {
  if (!process.env.WEBHOOK_URL) return;
  try {
    await axios.post(process.env.WEBHOOK_URL, payload);
    log('Webhook sent');
  } catch (err) {
    log(`Webhook error: ${err.message}`);
  }
}

async function notifyAisOn(ship, pos) {
  const label = ship.name || `MMSI ${ship.mmsi}`;
  const msg =
    `📡 AIS TURNED ON\n` +
    `🚢 ${label} (MMSI ${ship.mmsi})\n` +
    `🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}\n` +
    `🕐 ${new Date().toUTCString()}`;

  log(`AIS ON [${label}]`);
  await Promise.allSettled([
    sendPushover(msg),
    sendTelegram(msg),
    sendWebhook({ event: 'ais_on', mmsi: ship.mmsi, shipName: label, lat: pos.lat, lon: pos.lon, timestamp: new Date().toISOString() }),
  ]);
}

async function notifyEntry(ship, zone, pos) {
  const label = ship.name || `MMSI ${ship.mmsi}`;
  const msg =
    `🟢 ZONE ENTRY\n` +
    `🚢 ${label}\n` +
    `📍 Entered: ${zone.label}\n` +
    `🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)} — ${pos.distKm.toFixed(2)} km from centre\n` +
    `🕐 ${new Date().toUTCString()}`;

  log(`ENTRY [${label}] → ${zone.label}`);
  await Promise.allSettled([
    sendPushover(msg),
    sendTelegram(msg),
    sendWebhook({ event: 'zone_entry', mmsi: ship.mmsi, shipName: label, zone: zone.label, lat: pos.lat, lon: pos.lon, distKm: pos.distKm, timestamp: new Date().toISOString() }),
  ]);
}

async function notifyExit(ship, zone, pos) {
  const label = ship.name || `MMSI ${ship.mmsi}`;
  const msg =
    `🔴 ZONE EXIT / POSSIBLE DEPARTURE\n` +
    `🚢 ${label}\n` +
    `📍 Left: ${zone.label}\n` +
    `🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}\n` +
    `🕐 ${new Date().toUTCString()}`;

  log(`EXIT [${label}] ← ${zone.label}`);
  await Promise.allSettled([
    sendPushover(msg),
    sendTelegram(msg),
    sendWebhook({ event: 'zone_exit', mmsi: ship.mmsi, shipName: label, zone: zone.label, lat: pos.lat, lon: pos.lon, timestamp: new Date().toISOString() }),
  ]);
}

// ── AIS Message Handler ───────────────────────────────────────────────────────

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const meta = msg.MetaData;
  if (!meta) return;

  const mmsi = String(meta.MMSI);
  const lat  = meta.latitude;
  const lon  = meta.longitude;
  const ship = SHIP_MAP[mmsi];
  if (!ship) return;

  const displayName = ship.name || mmsi;

  // ── AIS-on detection ──────────────────────────────────────────────────────
  // First position report since tracker started = AIS just switched on
  // Note: also fires on tracker restart — see README
  if (!seenMmsis.has(mmsi)) {
    seenMmsis.add(mmsi);
    await notifyAisOn(ship, { lat, lon });
  }

  // ── Zone check ────────────────────────────────────────────────────────────
  if (!ship.zone) {
    log(`${displayName} — ${lat.toFixed(4)}, ${lon.toFixed(4)} (no zone configured)`);
    return;
  }

  const zone     = ship.zone;
  const distKm   = haversineKm(zone.lat, zone.lon, lat, lon);
  const inZone   = distKm <= zone.radiusKm;
  const stateKey = `${mmsi}::${zone.label}`;

  log(`${displayName} — ${distKm.toFixed(2)} km from "${zone.label}" (radius ${zone.radiusKm} km)`);

  if (inZone && !insideZone.has(stateKey)) {
    insideZone.add(stateKey);
    await notifyEntry(ship, zone, { lat, lon, distKm });
  } else if (!inZone && insideZone.has(stateKey)) {
    insideZone.delete(stateKey);
    await notifyExit(ship, zone, { lat, lon, distKm });
  }
}

// ── WebSocket Connection ──────────────────────────────────────────────────────

let reconnectDelay = 5000;

function connect() {
  log(`Connecting to aisstream.io`);
  log(`Tracking ${SHIPS.length} ship(s):`);
  SHIPS.forEach(s => {
    if (s.zone) log(`  ${s.name || s.mmsi} (${s.mmsi}) → zone "${s.zone.label}" radius ${s.zone.radiusKm} km`);
    else        log(`  ${s.name || s.mmsi} (${s.mmsi}) → AIS-on alert only (no zone)`);
  });

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    reconnectDelay = 5000;
    log('Connected. Sending subscription...');
    ws.send(JSON.stringify({
      APIKey:             AISSTREAM_KEY,
      BoundingBoxes:      BOUNDING_BOXES,
      FiltersShipMMSI:    TARGET_MMSIS,
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  ws.on('message', handleMessage);

  ws.on('close', (code, reason) => {
    log(`Disconnected (${code}: ${reason}). Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (!AISSTREAM_KEY || AISSTREAM_KEY === 'your_aisstream_api_key_here') {
  console.error('ERROR: Set AISSTREAM_KEY in your .env file first.');
  process.exit(1);
}

connect();
