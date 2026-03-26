require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const AISSTREAM_KEY    = process.env.AISSTREAM_KEY;
const TG_TOKEN         = process.env.TG_TOKEN;
const TG_CHAT_ID       = process.env.TG_CHAT_ID;
const SHIPS_FILE       = path.join(__dirname, 'ships.json');
const POLL_INTERVAL    = 2500;  // ms — Telegram command polling frequency
const AIS_CHECK_WINDOW = 30000; // ms — wait before "AIS still off" message

// ── Ships state ───────────────────────────────────────────────────────────────

let SHIPS    = [];
let SHIP_MAP = {};

function loadShips() {
  try {
    SHIPS    = JSON.parse(fs.readFileSync(SHIPS_FILE, 'utf8'));
    SHIP_MAP = {};
    for (const s of SHIPS) SHIP_MAP[String(s.mmsi)] = s;
    log(`Loaded ${SHIPS.length} ship(s) from ships.json`);
  } catch {
    log('ships.json not found or invalid — starting with empty list');
    SHIPS    = [];
    SHIP_MAP = {};
  }
}

function saveShips() {
  fs.writeFileSync(SHIPS_FILE, JSON.stringify(SHIPS, null, 2));
}

function buildBoundingBoxes() {
  const boxes = SHIPS
    .filter(s => s.zone)
    .map(s => [
      [s.zone.lat - 1, s.zone.lon - 1],
      [s.zone.lat + 1, s.zone.lon + 1],
    ]);
  return boxes.length > 0 ? boxes : [[[-90, -180], [90, 180]]];
}

// ── Runtime state ─────────────────────────────────────────────────────────────

const insideZone       = new Set(); // "mmsi::zoneLabel"
const seenMmsis        = new Set(); // MMSIs heard since startup
const pendingAisChecks = new Map(); // mmsi → { timer, chatId }

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
  } catch (err) {
    log(`Pushover error: ${err.message}`);
  }
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT_ID, text }
    );
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log(`Telegram error: ${detail}`);
  }
}

async function sendWebhook(payload) {
  if (!process.env.WEBHOOK_URL) return;
  try {
    await axios.post(process.env.WEBHOOK_URL, payload);
  } catch (err) {
    log(`Webhook error: ${err.message}`);
  }
}

async function notify(text, payload) {
  log(text.replace(/\n/g, ' | '));
  await Promise.allSettled([
    sendPushover(text),
    sendTelegram(text),
    sendWebhook({ ...payload, timestamp: new Date().toISOString() }),
  ]);
}

async function replyTelegram(chatId, text) {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    log(`Telegram reply error: ${err.message}`);
  }
}

// ── AIS event notifications ───────────────────────────────────────────────────

async function notifyAisOn(ship, pos) {
  const label = ship.name || `MMSI ${ship.mmsi}`;
  await notify(
    `📡 AIS TURNED ON\n🚢 ${label} (MMSI ${ship.mmsi})\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}\n🕐 ${new Date().toUTCString()}`,
    { event: 'ais_on', mmsi: ship.mmsi, shipName: label, lat: pos.lat, lon: pos.lon }
  );
}

async function notifyEntry(ship, zone, pos) {
  const label = ship.name || `MMSI ${ship.mmsi}`;
  await notify(
    `🟢 ZONE ENTRY\n🚢 ${label}\n📍 Entered: ${zone.label}\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)} — ${pos.distKm.toFixed(2)} km from centre\n🕐 ${new Date().toUTCString()}`,
    { event: 'zone_entry', mmsi: ship.mmsi, shipName: label, zone: zone.label, lat: pos.lat, lon: pos.lon, distKm: pos.distKm }
  );
}

async function notifyExit(ship, zone, pos) {
  const label = ship.name || `MMSI ${ship.mmsi}`;
  await notify(
    `🔴 ZONE EXIT / POSSIBLE DEPARTURE\n🚢 ${label}\n📍 Left: ${zone.label}\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}\n🕐 ${new Date().toUTCString()}`,
    { event: 'zone_exit', mmsi: ship.mmsi, shipName: label, zone: zone.label, lat: pos.lat, lon: pos.lon }
  );
}

// ── AIS-off follow-up timer ───────────────────────────────────────────────────

function scheduleAisCheck(mmsi, chatId) {
  clearPendingAisCheck(mmsi);
  const timer = setTimeout(async () => {
    pendingAisChecks.delete(mmsi);
    const ship = SHIP_MAP[mmsi];
    if (!ship) return;
    const label = ship.name || `MMSI ${mmsi}`;
    const secs  = AIS_CHECK_WINDOW / 1000;
    await replyTelegram(chatId,
      `⚠️ NO AIS SIGNAL DETECTED\n` +
      `🚢 ${label} (MMSI ${mmsi})\n` +
      `📵 No position report received in the last ${secs}s.\n` +
      `   AIS may be off or out of terrestrial coverage.\n` +
      `   You will be alerted automatically when it comes online.`
    );
    log(`AIS check timeout for ${label}`);
  }, AIS_CHECK_WINDOW);
  pendingAisChecks.set(mmsi, { timer, chatId });
}

function clearPendingAisCheck(mmsi) {
  const entry = pendingAisChecks.get(mmsi);
  if (entry) {
    clearTimeout(entry.timer);
    pendingAisChecks.delete(mmsi);
  }
}

// ── AIS message handler ───────────────────────────────────────────────────────

async function handleAisMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const meta = msg.MetaData;
  if (!meta) return;

  const mmsi = String(meta.MMSI);
  const lat  = meta.latitude;
  const lon  = meta.longitude;
  const ship = SHIP_MAP[mmsi];
  if (!ship) return;

  const displayName = ship.name || mmsi;

  if (!seenMmsis.has(mmsi)) {
    seenMmsis.add(mmsi);
    clearPendingAisCheck(mmsi);
    await notifyAisOn(ship, { lat, lon });
  }

  if (!ship.zone) {
    log(`${displayName} — ${lat.toFixed(4)}, ${lon.toFixed(4)} (no zone)`);
    return;
  }

  const zone     = ship.zone;
  const distKm   = haversineKm(zone.lat, zone.lon, lat, lon);
  const inZone   = distKm <= zone.radiusKm;
  const stateKey = `${mmsi}::${zone.label}`;

  log(`${displayName} — ${distKm.toFixed(2)} km from "${zone.label}"`);

  if (inZone && !insideZone.has(stateKey)) {
    insideZone.add(stateKey);
    await notifyEntry(ship, zone, { lat, lon, distKm });
  } else if (!inZone && insideZone.has(stateKey)) {
    insideZone.delete(stateKey);
    await notifyExit(ship, zone, { lat, lon, distKm });
  }
}

// ── Input validation ──────────────────────────────────────────────────────────

function validateMmsi(mmsi) {
  if (!/^\d{9}$/.test(mmsi))
    return 'MMSI must be exactly 9 digits (e.g. 123456789).';
  return null;
}

function validateZone(lat, lon, radiusKm) {
  const errors = [];
  if (isNaN(lat) || lat < -90 || lat > 90)
    errors.push(`Latitude must be between -90 and 90 (got "${lat}").`);
  if (isNaN(lon) || lon < -180 || lon > 180)
    errors.push(`Longitude must be between -180 and 180 (got "${lon}").`);
  if (isNaN(radiusKm) || radiusKm <= 0)
    errors.push(`Radius must be a positive number greater than 0 (got "${radiusKm}").`);
  return errors.length > 0 ? errors.join('\n') : null;
}

// ── /addship parser ───────────────────────────────────────────────────────────

function parseAddShip(args) {
  const tokens = args.trim().split(/\s+/);
  if (tokens.length < 1 || !tokens[0]) return { error: 'No MMSI provided.' };

  const mmsi = tokens[0];
  const mmsiErr = validateMmsi(mmsi);
  if (mmsiErr) return { error: mmsiErr };

  let name      = null;
  let zone      = null;
  let zoneStart = -1;

  for (let i = 1; i < tokens.length - 1; i++) {
    const mayLat    = parseFloat(tokens[i]);
    const mayLon    = parseFloat(tokens[i + 1]);
    const mayRadius = tokens[i + 2] !== undefined ? parseFloat(tokens[i + 2]) : NaN;

    if (!isNaN(mayLat) && !isNaN(mayLon) && !isNaN(mayRadius)) {
      const zoneErr = validateZone(mayLat, mayLon, mayRadius);
      if (zoneErr) return { error: zoneErr };
      zoneStart = i;
      const zoneLabel = tokens.slice(i + 3).join(' ') || 'Zone';
      zone = { label: zoneLabel, lat: mayLat, lon: mayLon, radiusKm: mayRadius };
      break;
    }
  }

  const nameEnd = zoneStart > -1 ? zoneStart : tokens.length;
  name = tokens.slice(1, nameEnd).join(' ') || null;

  return { mmsi, name, zone };
}

// ── Command handler ───────────────────────────────────────────────────────────

async function handleCommand(text, chatId) {
  const trimmed = text.trim();

  // ── /listships ──────────────────────────────────────────────────────────────
  if (trimmed === '/listships' || trimmed.startsWith('/listships ')) {
    if (SHIPS.length === 0) {
      await replyTelegram(chatId, '📋 No ships currently tracked.');
      return;
    }
    const lines = SHIPS.map(s => {
      const name   = s.name || '(unnamed)';
      const zone   = s.zone
        ? `\n   📍 ${s.zone.label} (${s.zone.lat}, ${s.zone.lon}) r=${s.zone.radiusKm} km`
        : '\n   📍 No zone';
      const status = seenMmsis.has(String(s.mmsi)) ? ' 🟢 AIS on' : ' 📵 AIS off';
      return `• ${name} — MMSI ${s.mmsi}${status}${zone}`;
    });
    await replyTelegram(chatId, `📋 Tracked ships (${SHIPS.length}):\n\n${lines.join('\n\n')}`);
    return;
  }

  // ── /removeship <mmsi> ──────────────────────────────────────────────────────
  if (trimmed.startsWith('/removeship')) {
    const mmsi = trimmed.split(/\s+/)[1];
    if (!mmsi) {
      await replyTelegram(chatId, '❌ Usage: /removeship <mmsi>');
      return;
    }
    const mmsiErr = validateMmsi(mmsi);
    if (mmsiErr) {
      await replyTelegram(chatId, `❌ ${mmsiErr}`);
      return;
    }
    const idx = SHIPS.findIndex(s => String(s.mmsi) === mmsi);
    if (idx === -1) {
      await replyTelegram(chatId, `❌ MMSI ${mmsi} not found in tracking list.`);
      return;
    }
    const removed = SHIPS.splice(idx, 1)[0];
    delete SHIP_MAP[mmsi];
    seenMmsis.delete(mmsi);
    clearPendingAisCheck(mmsi);
    saveShips();
    reconnectWebSocket();
    await replyTelegram(chatId, `✅ Removed ${removed.name || mmsi} (MMSI ${mmsi}) from tracking.`);
    log(`Removed ship: ${mmsi}`);
    return;
  }

  // ── /addship <mmsi> [name] [lat lon radiusKm [zoneLabel]] ───────────────────
  if (trimmed.startsWith('/addship')) {
    const args = trimmed.slice('/addship'.length).trim();
    if (!args) {
      await replyTelegram(chatId,
        '❌ Usage:\n' +
        '/addship <mmsi>\n' +
        '/addship <mmsi> <n>\n' +
        '/addship <mmsi> <n> <lat> <lon> <radiusKm>\n' +
        '/addship <mmsi> <n> <lat> <lon> <radiusKm> <zoneLabel>\n\n' +
        'Name and zone are optional.\n' +
        'MMSI must be exactly 9 digits.\n' +
        'Lat: -90 to 90 | Lon: -180 to 180 | Radius: > 0'
      );
      return;
    }

    const parsed = parseAddShip(args);
    if (parsed.error) {
      await replyTelegram(chatId, `❌ ${parsed.error}`);
      return;
    }

    const { mmsi, name, zone } = parsed;

    if (SHIP_MAP[mmsi]) {
      await replyTelegram(chatId, `⚠️ MMSI ${mmsi} is already being tracked. Use /removeship ${mmsi} first.`);
      return;
    }

    const ship = { mmsi, ...(name && { name }), ...(zone && { zone }) };
    SHIPS.push(ship);
    SHIP_MAP[mmsi] = ship;
    saveShips();
    reconnectWebSocket();

    const nameStr = name || '(unnamed)';
    const zoneStr = zone
      ? `\n📍 Zone: ${zone.label} (${zone.lat}, ${zone.lon}) radius ${zone.radiusKm} km`
      : '\n📍 No zone — AIS-on alert only';
    const secs = AIS_CHECK_WINDOW / 1000;

    await replyTelegram(chatId,
      `✅ Added ${nameStr} (MMSI ${mmsi})${zoneStr}\n` +
      `⏳ Checking for AIS signal — will confirm within ${secs}s...`
    );
    scheduleAisCheck(mmsi, chatId);
    log(`Added ship: ${mmsi} name=${name} zone=${JSON.stringify(zone)}`);
    return;
  }

  // ── Unknown command ──────────────────────────────────────────────────────────
  await replyTelegram(chatId,
    '🤖 Available commands:\n' +
    '/addship <mmsi> [name] [lat lon radiusKm [zoneLabel]]\n' +
    '/removeship <mmsi>\n' +
    '/listships'
  );
}

// ── Telegram polling loop ─────────────────────────────────────────────────────

let lastUpdateId = 0;

async function pollTelegram() {
  if (!TG_TOKEN) return;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates`,
      { params: { offset: lastUpdateId + 1, timeout: 0 } }
    );
    const updates = res.data.result || [];
    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const text = msg.text;
      if (!text.startsWith('/')) continue;
      log(`Command received: ${text}`);
      await handleCommand(text, msg.chat.id);
    }
  } catch (err) {
    log(`Telegram poll error: ${err.message}`);
  }
  setTimeout(pollTelegram, POLL_INTERVAL);
}

// ── WebSocket connection ──────────────────────────────────────────────────────

let ws             = null;
let reconnectDelay = 5000;

function connect() {
  log(`Connecting to aisstream.io — tracking ${SHIPS.length} ship(s)`);
  SHIPS.forEach(s => {
    if (s.zone) log(`  ${s.name || s.mmsi} (${s.mmsi}) → "${s.zone.label}" r=${s.zone.radiusKm} km`);
    else        log(`  ${s.name || s.mmsi} (${s.mmsi}) → AIS-on only`);
  });

  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    reconnectDelay = 5000;
    log('Connected. Sending subscription...');
    ws.send(JSON.stringify({
      APIKey:             AISSTREAM_KEY,
      BoundingBoxes:      buildBoundingBoxes(),
      FiltersShipMMSI:    SHIPS.map(s => String(s.mmsi)),
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  ws.on('message', handleAisMessage);

  ws.on('close', (code, reason) => {
    log(`Disconnected (${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on('error', (err) => log(`WebSocket error: ${err.message}`));
}

function reconnectWebSocket() {
  log('Ship list changed — reconnecting WebSocket with updated subscription...');
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (!AISSTREAM_KEY || AISSTREAM_KEY === 'your_aisstream_api_key_here') {
  console.error('ERROR: Set AISSTREAM_KEY in your .env file first.');
  process.exit(1);
}

loadShips();
for (const ship of SHIPS) scheduleAisCheck(String(ship.mmsi), TG_CHAT_ID);
connect();
pollTelegram();
