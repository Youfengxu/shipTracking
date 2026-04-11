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
const ZONES_FILE       = path.join(__dirname, 'zones.json');
const AIS_CHECK_WINDOW = 30000; // ms — wait before "AIS still off" message

// ── Ships state ───────────────────────────────────────────────────────────────

let SHIPS    = [];
let SHIP_MAP = {};

function loadShips() {
  try {
    const raw = JSON.parse(fs.readFileSync(SHIPS_FILE, 'utf8'));
    SHIPS = raw.map(s => {
      if (s.zone && !s.zones) {
        const { zone, ...rest } = s;
        return { ...rest, zones: [zone] };
      }
      return { zones: [], ...s };
    });
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

// ── Zone registry ─────────────────────────────────────────────────────────────

let ZONES = {}; // label → { label, lat, lon, radiusKm }

function loadZones() {
  try {
    ZONES = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8'));
    log(`Loaded ${Object.keys(ZONES).length} zone(s) from zones.json`);
  } catch {
    ZONES = {};
  }
}

function saveZones() {
  fs.writeFileSync(ZONES_FILE, JSON.stringify(ZONES, null, 2));
}

function resolveZoneLabel(label) {
  const lower = label.toLowerCase();
  const key = Object.keys(ZONES).find(k => k.toLowerCase() === lower);
  return key ? ZONES[key] : null;
}

function buildBoundingBoxes() {
  const boxes = [];
  for (const s of SHIPS) {
    for (const z of (s.zones || [])) {
      boxes.push([
        [z.lat - 1, z.lon - 1],
        [z.lat + 1, z.lon + 1],
      ]);
    }
  }
  return boxes.length > 0 ? boxes : [[[-90, -180], [90, 180]]];
}

// ── Runtime state ─────────────────────────────────────────────────────────────

const insideZone       = new Set(); // "mmsi::zoneLabel"
const pendingAisChecks = new Map(); // mmsi → { timer, chatId }
const mmsiChangeAlerts = new Map(); // "trackedMmsi::newMmsi" → last alert ms (1hr cooldown)
const lastPosition     = new Map(); // mmsi → { lat, lon, ts }
const STARTUP_GRACE_MS = 5 * 60 * 1000; // suppress restart-noise for 5 min after boot
const STALE_MS         = 30 * 60 * 1000; // 30 min without signal = considered off
const startupTime      = Date.now();

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

function hasEnhancedTracking(ship) {
  return !!(ship.callsign || (ship.altNames && ship.altNames.length > 0));
}

const NAVAL_PREFIXES = new Set([
  'USS','HMS','HMAS','HMNZS','KRI','KD','JS','MV','MT','SV',
  'HDMS','FGS','FS','HNLMS','HTMS','KDB','RSS','INS','BRP','RFA',
]);

function aisNameToDisplay(raw) {
  return raw.split(/\s+/).map(word => {
    const upper = word.toUpperCase();
    return NAVAL_PREFIXES.has(upper)
      ? upper
      : upper.charAt(0) + word.slice(1).toLowerCase();
  }).join(' ');
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

async function sendTelegram(text, parseMode) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const body = { chat_id: TG_CHAT_ID, text };
    if (parseMode) body.parse_mode = parseMode;
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, body);
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

async function notify(text, payload, tgHtml) {
  log(text.replace(/\n/g, ' | '));
  await Promise.allSettled([
    sendPushover(text),
    sendTelegram(tgHtml || text, tgHtml ? 'HTML' : undefined),
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

// ── Geocoding + coord formatting ──────────────────────────────────────────────

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': 'ship-tracker/1.0' },
      timeout: 5000,
    });
    const addr = resp.data.address || {};
    if (addr.sea)   return addr.sea;
    if (addr.ocean) return addr.ocean;
    if (addr.bay)   return addr.bay;
    const parts = [
      addr.suburb || addr.quarter || addr.neighbourhood || addr.village || addr.town,
      addr.city || addr.county || addr.state,
      addr.country,
    ].filter(Boolean);
    return parts.slice(0, 2).join(', ') || null;
  } catch {
    return null;
  }
}

function mapsUrl(lat, lon) {
  return `https://www.google.com/maps?q=${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function coordHtml(lat, lon) {
  return `<a href="${mapsUrl(lat, lon)}">${lat.toFixed(4)}, ${lon.toFixed(4)}</a>`;
}

// ── AIS event notifications ───────────────────────────────────────────────────

async function notifyAisOn(ship, pos) {
  const label    = ship.name || `MMSI ${ship.mmsi}`;
  const location = await reverseGeocode(pos.lat, pos.lon);
  const locLine  = location ? `\n📍 ${location}` : '';
  const plain    = `📡 AIS TURNED ON\n🚢 ${label} (MMSI ${ship.mmsi})\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html     = `📡 AIS TURNED ON\n🚢 ${label} (MMSI ${ship.mmsi})\n🌐 ${coordHtml(pos.lat, pos.lon)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'ais_on', mmsi: ship.mmsi, shipName: label, lat: pos.lat, lon: pos.lon }, html);
}

async function notifyEntry(ship, zone, pos) {
  const label    = ship.name || `MMSI ${ship.mmsi}`;
  const location = await reverseGeocode(pos.lat, pos.lon);
  const locLine  = location ? `\n📍 ${location}` : '';
  const plain    = `🟢 ZONE ENTRY\n🚢 ${label}\n📍 Entered: ${zone.label}\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)} — ${pos.distKm.toFixed(2)} km from centre${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html     = `🟢 ZONE ENTRY\n🚢 ${label}\n📍 Entered: ${zone.label}\n🌐 ${coordHtml(pos.lat, pos.lon)} — ${pos.distKm.toFixed(2)} km from centre${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'zone_entry', mmsi: ship.mmsi, shipName: label, zone: zone.label, lat: pos.lat, lon: pos.lon, distKm: pos.distKm }, html);
}

async function notifyExit(ship, zone, pos) {
  const label    = ship.name || `MMSI ${ship.mmsi}`;
  const location = await reverseGeocode(pos.lat, pos.lon);
  const locLine  = location ? `\n📍 ${location}` : '';
  const plain    = `🔴 ZONE EXIT / POSSIBLE DEPARTURE\n🚢 ${label}\n📍 Left: ${zone.label}\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html     = `🔴 ZONE EXIT / POSSIBLE DEPARTURE\n🚢 ${label}\n📍 Left: ${zone.label}\n🌐 ${coordHtml(pos.lat, pos.lon)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'zone_exit', mmsi: ship.mmsi, shipName: label, zone: zone.label, lat: pos.lat, lon: pos.lon }, html);
}

async function notifyPossibleMmsiChange(ship, newMmsi, reason, lat, lon) {
  const key = `${ship.mmsi}::${newMmsi}`;
  const now = Date.now();
  if (mmsiChangeAlerts.has(key) && now - mmsiChangeAlerts.get(key) < 3_600_000) return;
  mmsiChangeAlerts.set(key, now);
  const label    = ship.name || `MMSI ${ship.mmsi}`;
  const location = await reverseGeocode(lat, lon);
  const locLine  = location ? `\n📍 ${location}` : '';
  const plain    = `⚠️ POSSIBLE MMSI CHANGE\n🚢 ${label} (tracked MMSI ${ship.mmsi})\n📡 Spotted MMSI: ${newMmsi} (${reason})\n🌐 ${lat.toFixed(4)}, ${lon.toFixed(4)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html     = `⚠️ POSSIBLE MMSI CHANGE\n🚢 ${label} (tracked MMSI ${ship.mmsi})\n📡 Spotted MMSI: ${newMmsi} (${reason})\n🌐 ${coordHtml(lat, lon)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'possible_mmsi_change', trackedMmsi: ship.mmsi, newMmsi, shipName: label, reason, lat, lon }, html);
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

  // ── ShipStaticData: name/callsign matching against all enhanced-tracked ships ──
  if (msg.MessageType === 'ShipStaticData') {
    const sd         = msg.Message?.ShipStaticData;
    const rxName     = (sd?.Name || meta.ShipName || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const rxCallsign = (sd?.CallSign || '').trim().toUpperCase();
    if (!rxName && !rxCallsign) return;

    // Auto-populate name/callsign for tracked ships that are missing them
    const ownShip = SHIP_MAP[mmsi];
    if (ownShip && (!ownShip.name || !ownShip.callsign)) {
      let updated = false;
      if (rxName && !ownShip.name) {
        ownShip.name = aisNameToDisplay(rxName);
        updated = true;
      }
      if (rxCallsign && !ownShip.callsign) {
        ownShip.callsign = rxCallsign;
        updated = true;
      }
      if (updated) {
        saveShips();
        const label = ownShip.name || `MMSI ${mmsi}`;
        log(`Auto-populated ${label} (MMSI ${mmsi}) — name=${ownShip.name || '–'} callsign=${ownShip.callsign || '–'}`);
        const lines = [`📋 Ship details auto-populated`, `🚢 MMSI ${mmsi}`];
        if (ownShip.name)     lines.push(`   Name: ${ownShip.name}`);
        if (ownShip.callsign) lines.push(`   Callsign: ${ownShip.callsign}`);
        await sendTelegram(lines.join('\n'));
      }
    }

    for (const trackedShip of SHIPS) {
      if (String(trackedShip.mmsi) === mmsi) continue; // same MMSI — no alert
      if (!hasEnhancedTracking(trackedShip)) continue;

      let reason = null;
      if (rxCallsign && trackedShip.callsign &&
          rxCallsign === trackedShip.callsign.toUpperCase()) {
        reason = `callsign "${rxCallsign}"`;
      } else if (rxName) {
        const names = [
          (trackedShip.name || '').toUpperCase(),
          ...((trackedShip.altNames || []).map(n => n.toUpperCase())),
        ].filter(Boolean);
        if (names.some(n => n && rxName === n)) reason = `name "${rxName}"`;
      }
      if (reason) await notifyPossibleMmsiChange(trackedShip, mmsi, reason, lat, lon);
    }
    return;
  }

  // ── PositionReport: normal tracking + MMSI-prefix proximity for unknown MMSI ──
  const ship = SHIP_MAP[mmsi];

  if (!ship) {
    // Unknown MMSI: check if same prefix appears inside a zone of an enhanced-tracked ship
    const prefix = mmsi.slice(0, 3);
    for (const trackedShip of SHIPS) {
      if (!hasEnhancedTracking(trackedShip)) continue;
      if (!String(trackedShip.mmsi).startsWith(prefix)) continue;
      for (const zone of (trackedShip.zones || [])) {
        if (haversineKm(zone.lat, zone.lon, lat, lon) <= zone.radiusKm) {
          await notifyPossibleMmsiChange(
            trackedShip, mmsi,
            `same MMSI prefix ${prefix} inside zone "${zone.label}"`,
            lat, lon
          );
          break;
        }
      }
    }
    return;
  }

  // Known tracked ship — standard zone/AIS-on logic
  const displayName = ship.name || mmsi;

  // Check if ship was considered off before this update
  const prev   = lastPosition.get(mmsi);
  const wasOff = !prev || (Date.now() - new Date(prev.ts).getTime()) > STALE_MS;

  // Update position
  lastPosition.set(mmsi, { lat, lon, ts: new Date().toISOString() });

  if (wasOff) {
    clearPendingAisCheck(mmsi);
    if (Date.now() - startupTime > STARTUP_GRACE_MS) {
      await notifyAisOn(ship, { lat, lon });
    }
  }

  const zones = ship.zones || [];
  if (zones.length === 0) {
    log(`${displayName} — ${lat.toFixed(4)}, ${lon.toFixed(4)} (no zone)`);
    return;
  }

  for (const zone of zones) {
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
}

// ── WebSocket connection ──────────────────────────────────────────────────────

let ws             = null;
let reconnectDelay = 5000;

function connect() {
  log(`Connecting to aisstream.io — tracking ${SHIPS.length} ship(s)`);
  SHIPS.forEach(s => {
    const zones = s.zones || [];
    if (zones.length > 0) zones.forEach(z => log(`  ${s.name || s.mmsi} (${s.mmsi}) → "${z.label}" r=${z.radiusKm} km`));
    else                  log(`  ${s.name || s.mmsi} (${s.mmsi}) → AIS-on only`);
  });

  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    reconnectDelay = 5000;
    log('Connected. Sending subscription...');
    const enhanced = SHIPS.some(hasEnhancedTracking);
    ws.send(JSON.stringify({
      APIKey:             AISSTREAM_KEY,
      BoundingBoxes:      buildBoundingBoxes(),
      // When any ship has enhanced tracking, receive all vessels in the bounding
      // boxes so we can match by name/callsign/MMSI-prefix from unknown MMSIs.
      ...(enhanced ? {} : { FiltersShipMMSI: SHIPS.map(s => String(s.mmsi)) }),
      FilterMessageTypes: enhanced ? ['PositionReport', 'ShipStaticData'] : ['PositionReport'],
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

loadZones();
loadShips();
connect();

// ── File watchers — auto-reload without restart ───────────────────────────────

let reloadShipsTimer = null;
fs.watch(SHIPS_FILE, () => {
  clearTimeout(reloadShipsTimer);
  reloadShipsTimer = setTimeout(() => {
    log('ships.json changed — reloading...');
    loadShips();
    reconnectWebSocket();
  }, 500);
});

let reloadZonesTimer = null;
fs.watch(ZONES_FILE, () => {
  clearTimeout(reloadZonesTimer);
  reloadZonesTimer = setTimeout(() => {
    log('zones.json changed — reloading...');
    loadZones();
  }, 500);
});

// ── HTTP status API ───────────────────────────────────────────────────────────

const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/status') {
    const out = {};
    for (const [mmsi, pos] of lastPosition) {
      const ship       = SHIP_MAP[mmsi];
      const zones      = ship ? (ship.zones || []) : [];
      const activeZones = zones
        .filter(z => z.label && insideZone.has(`${mmsi}::${z.label}`))
        .map(z => z.label);
      out[mmsi] = {
        name:        ship ? (ship.name || mmsi) : mmsi,
        lat:         pos.lat,
        lon:         pos.lon,
        ts:          pos.ts,
        insideZones: activeZones,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(3001, '127.0.0.1', () => {
  log('HTTP status API listening on http://127.0.0.1:3001/status');
});
