require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────

const AISSTREAM_KEY = process.env.AISSTREAM_KEY;
const TARGET_MMSIS  = process.env.TARGET_MMSIS.split(',').map(m => m.trim());

const ZONE = {
  lat:      parseFloat(process.env.ZONE_LAT),
  lon:      parseFloat(process.env.ZONE_LON),
  radiusKm: parseFloat(process.env.ZONE_RADIUS_KM),
};

// Bounding box: ± 1 degree around zone centre (aisstream pre-filter)
// Actual precision is handled by the haversine check below
const BBOX = [[
  [ZONE.lat - 1, ZONE.lon - 1],
  [ZONE.lat + 1, ZONE.lon + 1],
]];

// ── State ─────────────────────────────────────────────────────────────────────

const insideZone = new Set(); // MMSIs currently inside the zone

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

async function notifyEntry(ship) {
  const msg =
    `🚢 ${ship.name || 'Unknown vessel'} (MMSI ${ship.mmsi}) ` +
    `entered your zone\n` +
    `📍 ${ship.lat.toFixed(4)}, ${ship.lon.toFixed(4)} — ` +
    `${ship.distKm.toFixed(2)} km from centre\n` +
    `🕐 ${new Date().toUTCString()}`;

  log(`ENTRY: ${msg}`);
  await Promise.allSettled([
    sendPushover(msg),
    sendTelegram(msg),
    sendWebhook({ event: 'zone_entry', ...ship, timestamp: new Date().toISOString() }),
  ]);
}

async function notifyExit(ship) {
  const msg =
    `📤 ${ship.name || 'Unknown vessel'} (MMSI ${ship.mmsi}) left your zone\n` +
    `🕐 ${new Date().toUTCString()}`;

  log(`EXIT: ${msg}`);
  await Promise.allSettled([
    sendPushover(msg),
    sendTelegram(msg),
    sendWebhook({ event: 'zone_exit', ...ship, timestamp: new Date().toISOString() }),
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

  // aisstream wraps position data under MetaData
  const meta = msg.MetaData;
  if (!meta) return;

  const mmsi    = String(meta.MMSI);
  const lat     = meta.latitude;
  const lon     = meta.longitude;
  const name    = (meta.ShipName || '').trim();
  const distKm  = haversineKm(ZONE.lat, ZONE.lon, lat, lon);
  const inZone  = distKm <= ZONE.radiusKm;

  log(`${name || mmsi} — ${distKm.toFixed(2)} km from zone centre`);

  if (inZone && !insideZone.has(mmsi)) {
    insideZone.add(mmsi);
    await notifyEntry({ mmsi, name, lat, lon, distKm });
  } else if (!inZone && insideZone.has(mmsi)) {
    insideZone.delete(mmsi);
    await notifyExit({ mmsi, name, lat, lon, distKm });
  }
}

// ── WebSocket Connection ──────────────────────────────────────────────────────

let reconnectDelay = 5000;

function connect() {
  log(`Connecting to aisstream.io — tracking MMSIs: ${TARGET_MMSIS.join(', ')}`);
  log(`Zone: ${ZONE.lat}, ${ZONE.lon} — radius ${ZONE.radiusKm} km`);

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    reconnectDelay = 5000; // reset backoff on successful connect
    log('Connected. Sending subscription...');
    ws.send(JSON.stringify({
      APIKey:             AISSTREAM_KEY,
      BoundingBoxes:      BBOX,
      FiltersShipMMSI:    TARGET_MMSIS,
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  ws.on('message', handleMessage);

  ws.on('close', (code, reason) => {
    log(`Disconnected (${code}: ${reason}). Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000); // exponential backoff, max 60s
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
    // 'close' event will fire after this and handle reconnect
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (!AISSTREAM_KEY || AISSTREAM_KEY === 'your_aisstream_api_key_here') {
  console.error('ERROR: Set AISSTREAM_KEY in your .env file first.');
  process.exit(1);
}

connect();
