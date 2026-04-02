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
const POLL_INTERVAL    = 2500;  // ms — Telegram command polling frequency
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
const seenMmsis        = new Set(); // MMSIs heard since startup
const pendingAisChecks = new Map(); // mmsi → { timer, chatId }
const mmsiChangeAlerts = new Map(); // "trackedMmsi::newMmsi" → last alert ms (1hr cooldown)

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

async function notifyPossibleMmsiChange(ship, newMmsi, reason, lat, lon) {
  const key = `${ship.mmsi}::${newMmsi}`;
  const now = Date.now();
  if (mmsiChangeAlerts.has(key) && now - mmsiChangeAlerts.get(key) < 3_600_000) return;
  mmsiChangeAlerts.set(key, now);
  const label = ship.name || `MMSI ${ship.mmsi}`;
  await notify(
    `⚠️ POSSIBLE MMSI CHANGE\n🚢 ${label} (tracked MMSI ${ship.mmsi})\n📡 Spotted MMSI: ${newMmsi} (${reason})\n🌐 ${lat.toFixed(4)}, ${lon.toFixed(4)}\n🕐 ${new Date().toUTCString()}`,
    { event: 'possible_mmsi_change', trackedMmsi: ship.mmsi, newMmsi, shipName: label, reason, lat, lon }
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

  // ── ShipStaticData: name/callsign matching against all enhanced-tracked ships ──
  if (msg.MessageType === 'ShipStaticData') {
    const sd         = msg.Message?.ShipStaticData;
    const rxName     = (sd?.Name || meta.ShipName || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const rxCallsign = (sd?.CallSign || '').trim().toUpperCase();
    if (!rxName && !rxCallsign) return;

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

  if (!seenMmsis.has(mmsi)) {
    seenMmsis.add(mmsi);
    clearPendingAisCheck(mmsi);
    await notifyAisOn(ship, { lat, lon });
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

function parseZoneFromTokens(tokens, startIdx) {
  for (let i = startIdx; i < tokens.length - 1; i++) {
    const mayLat    = parseFloat(tokens[i]);
    const mayLon    = parseFloat(tokens[i + 1]);
    const mayRadius = tokens[i + 2] !== undefined ? parseFloat(tokens[i + 2]) : NaN;

    if (!isNaN(mayLat) && !isNaN(mayLon) && !isNaN(mayRadius)) {
      const zoneErr = validateZone(mayLat, mayLon, mayRadius);
      if (zoneErr) return { error: zoneErr };
      const zoneLabel = tokens.slice(i + 3).join(' ') || 'Zone';
      return { zone: { label: zoneLabel, lat: mayLat, lon: mayLon, radiusKm: mayRadius }, zoneStart: i };
    }
  }
  return { zone: null, zoneStart: -1 };
}

function findZoneLabelSuffix(tokens) {
  for (let len = tokens.length; len >= 1; len--) {
    const candidate = tokens.slice(-len).join(' ');
    const zone = resolveZoneLabel(candidate);
    if (zone) return { zone, prefixLen: tokens.length - len };
  }
  return null;
}

function parseAddShip(args) {
  const tokens = args.trim().split(/\s+/);
  if (tokens.length < 1 || !tokens[0]) return { error: 'No MMSI or ship name provided.' };

  // MMSI-based: first token is exactly 9 digits
  if (/^\d{9}$/.test(tokens[0])) {
    const mmsi = tokens[0];
    const rest = tokens.slice(1);

    // Try coordinate triple first
    const { zone, zoneStart, error } = parseZoneFromTokens(tokens, 1);
    if (error) return { error };
    if (zone) {
      const name = tokens.slice(1, zoneStart).join(' ') || null;
      return { mmsi, name, zone };
    }

    // Try registered zone label suffix
    const match = findZoneLabelSuffix(rest);
    if (match) {
      const name = rest.slice(0, match.prefixLen).join(' ') || null;
      return { mmsi, name, zone: match.zone };
    }

    // No zone
    const name = rest.join(' ') || null;
    return { mmsi, name, zone: null };
  }

  // Name-based: try coordinate triple first
  const { zone, zoneStart, error } = parseZoneFromTokens(tokens, 0);
  if (error) return { error };
  if (zone) {
    const shipName = tokens.slice(0, zoneStart).join(' ');
    if (!shipName) return { error: 'No ship name provided.' };
    return { byName: shipName, zone };
  }

  // Try registered zone label suffix
  const match = findZoneLabelSuffix(tokens);
  if (match) {
    const shipName = tokens.slice(0, match.prefixLen).join(' ');
    if (!shipName) return { error: 'No ship name provided.' };
    return { byName: shipName, zone: match.zone };
  }

  return { error: 'No zone coordinates or known zone label found.\nUse /addzone to register a zone first, or provide coordinates: <lat> <lon> <radiusKm> [zoneLabel]' };
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
      const name     = s.name || '(unnamed)';
      const status   = seenMmsis.has(String(s.mmsi)) ? ' 🟢 AIS on' : ' 📵 AIS off';
      const zones    = (s.zones || []).length > 0
        ? (s.zones).map(z => `\n   📍 ${z.label} (${z.lat}, ${z.lon}) r=${z.radiusKm} km`).join('')
        : '\n   📍 No zone';
      const callsign = s.callsign ? `\n   📡 Callsign: ${s.callsign}` : '';
      const altNames = (s.altNames || []).length > 0 ? `\n   🔤 Alt names: ${s.altNames.join(', ')}` : '';
      return `• ${name} — MMSI ${s.mmsi}${status}${callsign}${altNames}${zones}`;
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

  // ── /addzone <lat> <lon> <radiusKm> <zoneLabel> ─────────────────────────────
  if (trimmed.startsWith('/addzone')) {
    const args = trimmed.slice('/addzone'.length).trim();
    if (!args) {
      await replyTelegram(chatId, '❌ Usage: /addzone <lat> <lon> <radiusKm> <zoneLabel>');
      return;
    }
    const tokens = args.split(/\s+/);
    if (tokens.length < 4) {
      await replyTelegram(chatId, '❌ All arguments required: /addzone <lat> <lon> <radiusKm> <zoneLabel>');
      return;
    }
    const lat      = parseFloat(tokens[0]);
    const lon      = parseFloat(tokens[1]);
    const radiusKm = parseFloat(tokens[2]);
    const label    = tokens.slice(3).join(' ');
    const zoneErr  = validateZone(lat, lon, radiusKm);
    if (zoneErr) {
      await replyTelegram(chatId, `❌ ${zoneErr}`);
      return;
    }
    ZONES[label] = { label, lat, lon, radiusKm };
    saveZones();
    await replyTelegram(chatId, `✅ Zone "${label}" saved\n📍 (${lat}, ${lon}) radius ${radiusKm} km`);
    log(`Added zone: ${label} (${lat}, ${lon}) r=${radiusKm} km`);
    return;
  }

  // ── /addship <mmsi> [name] [lat lon radiusKm [zoneLabel]] ───────────────────
  if (trimmed.startsWith('/addship')) {
    const args = trimmed.slice('/addship'.length).trim();
    if (!args) {
      await replyTelegram(chatId,
        '❌ Usage:\n' +
        '/addship <mmsi>\n' +
        '/addship <mmsi> <name>\n' +
        '/addship <mmsi> <name> <lat> <lon> <radiusKm> [zoneLabel]\n' +
        '/addship <mmsi> <name> <savedZoneLabel>\n\n' +
        'To add a zone to an existing ship by name:\n' +
        '/addship <name> <lat> <lon> <radiusKm> [zoneLabel]\n' +
        '/addship <name> <savedZoneLabel>\n\n' +
        'Register zones first with /addzone.\n' +
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

    // Name-based: add a zone to an existing ship
    if (parsed.byName !== undefined) {
      const nameLower = parsed.byName.toLowerCase();
      const existing  = SHIPS.find(s => s.name && s.name.toLowerCase() === nameLower);
      if (!existing) {
        await replyTelegram(chatId, `❌ No ship named "${parsed.byName}" found. Use /listships to see tracked ships.`);
        return;
      }
      existing.zones.push(parsed.zone);
      saveShips();
      reconnectWebSocket();
      const z = parsed.zone;
      await replyTelegram(chatId,
        `✅ Added zone to ${existing.name} (MMSI ${existing.mmsi})\n` +
        `📍 ${z.label} (${z.lat}, ${z.lon}) radius ${z.radiusKm} km`
      );
      log(`Added zone to ship ${existing.mmsi}: ${JSON.stringify(parsed.zone)}`);
      return;
    }

    const { mmsi, name, zone } = parsed;

    if (SHIP_MAP[mmsi]) {
      await replyTelegram(chatId, `⚠️ MMSI ${mmsi} is already being tracked. Use /removeship ${mmsi} first.`);
      return;
    }

    const ship = { mmsi, ...(name && { name }), zones: zone ? [zone] : [] };
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
    log(`Added ship: ${mmsi} name=${name} zones=${JSON.stringify(ship.zones)}`);
    return;
  }

  // ── /setcallsign <name_or_mmsi> <callsign|clear> ────────────────────────────
  if (trimmed.startsWith('/setcallsign')) {
    const args = trimmed.slice('/setcallsign'.length).trim();
    if (!args) {
      await replyTelegram(chatId, '❌ Usage: /setcallsign <name_or_mmsi> <callsign>\nUse "clear" to remove the callsign.');
      return;
    }
    const tokens = args.split(/\s+/);
    if (tokens.length < 2) {
      await replyTelegram(chatId, '❌ Usage: /setcallsign <name_or_mmsi> <callsign>\nUse "clear" to remove the callsign.');
      return;
    }
    const callsignArg = tokens[tokens.length - 1];
    const identifier  = tokens.slice(0, -1).join(' ');
    const ship = /^\d{9}$/.test(identifier)
      ? SHIP_MAP[identifier]
      : SHIPS.find(s => s.name && s.name.toLowerCase() === identifier.toLowerCase());
    if (!ship) {
      await replyTelegram(chatId, `❌ No ship found for "${identifier}". Use /listships to see tracked ships.`);
      return;
    }
    if (callsignArg.toLowerCase() === 'clear') {
      delete ship.callsign;
      saveShips();
      reconnectWebSocket();
      await replyTelegram(chatId, `✅ Callsign cleared for ${ship.name || ship.mmsi}.`);
    } else {
      ship.callsign = callsignArg.toUpperCase();
      saveShips();
      reconnectWebSocket();
      await replyTelegram(chatId,
        `✅ Callsign for ${ship.name || ship.mmsi} set to ${ship.callsign}\n` +
        `📡 Enhanced MMSI-change detection now active.`
      );
    }
    log(`Callsign ${callsignArg.toLowerCase() === 'clear' ? 'cleared' : 'set to ' + callsignArg.toUpperCase()} for MMSI ${ship.mmsi}`);
    return;
  }

  // ── /addaltname <name_or_mmsi> <altName> ────────────────────────────────────
  if (trimmed.startsWith('/addaltname')) {
    const args = trimmed.slice('/addaltname'.length).trim();
    if (!args) {
      await replyTelegram(chatId, '❌ Usage: /addaltname <name_or_mmsi> <altName>');
      return;
    }
    const tokens = args.split(/\s+/);
    if (tokens.length < 2) {
      await replyTelegram(chatId, '❌ Usage: /addaltname <name_or_mmsi> <altName>');
      return;
    }
    const altName    = tokens[tokens.length - 1];
    const identifier = tokens.slice(0, -1).join(' ');
    const ship = /^\d{9}$/.test(identifier)
      ? SHIP_MAP[identifier]
      : SHIPS.find(s => s.name && s.name.toLowerCase() === identifier.toLowerCase());
    if (!ship) {
      await replyTelegram(chatId, `❌ No ship found for "${identifier}". Use /listships to see tracked ships.`);
      return;
    }
    if (!ship.altNames) ship.altNames = [];
    const upper = altName.toUpperCase();
    if (ship.altNames.map(n => n.toUpperCase()).includes(upper)) {
      await replyTelegram(chatId, `⚠️ "${altName}" is already an alt name for ${ship.name || ship.mmsi}.`);
      return;
    }
    ship.altNames.push(altName);
    saveShips();
    reconnectWebSocket();
    await replyTelegram(chatId,
      `✅ Added alt name "${altName}" to ${ship.name || ship.mmsi}\n` +
      `📡 Enhanced MMSI-change detection now active.`
    );
    log(`Added alt name "${altName}" to MMSI ${ship.mmsi}`);
    return;
  }

  // ── /updatemmsi <name> <newMmsi> ────────────────────────────────────────────
  if (trimmed.startsWith('/updatemmsi')) {
    const tokens = trimmed.slice('/updatemmsi'.length).trim().split(/\s+/);
    if (tokens.length < 2 || !tokens[0]) {
      await replyTelegram(chatId, '❌ Usage: /updatemmsi <name> <newMmsi>');
      return;
    }
    const newMmsi   = tokens[tokens.length - 1];
    const shipName  = tokens.slice(0, -1).join(' ');
    const mmsiErr   = validateMmsi(newMmsi);
    if (mmsiErr) {
      await replyTelegram(chatId, `❌ ${mmsiErr}`);
      return;
    }
    const nameLower = shipName.toLowerCase();
    const ship      = SHIPS.find(s => s.name && s.name.toLowerCase() === nameLower);
    if (!ship) {
      await replyTelegram(chatId, `❌ No ship named "${shipName}" found. Use /listships to see tracked ships.`);
      return;
    }
    if (SHIP_MAP[newMmsi]) {
      await replyTelegram(chatId, `⚠️ MMSI ${newMmsi} is already assigned to ${SHIP_MAP[newMmsi].name || newMmsi}.`);
      return;
    }
    const oldMmsi = String(ship.mmsi);
    // migrate runtime state keyed on old MMSI
    clearPendingAisCheck(oldMmsi);
    seenMmsis.delete(oldMmsi);
    for (const key of insideZone) {
      if (key.startsWith(oldMmsi + '::')) {
        insideZone.delete(key);
        insideZone.add(newMmsi + '::' + key.slice(oldMmsi.length + 2));
      }
    }
    delete SHIP_MAP[oldMmsi];
    ship.mmsi = newMmsi;
    SHIP_MAP[newMmsi] = ship;
    saveShips();
    reconnectWebSocket();
    await replyTelegram(chatId, `✅ ${ship.name}: MMSI updated ${oldMmsi} → ${newMmsi}`);
    log(`Updated MMSI for ${ship.name}: ${oldMmsi} → ${newMmsi}`);
    return;
  }

  // ── /help ────────────────────────────────────────────────────────────────────
  if (trimmed === '/help' || trimmed.startsWith('/help ')) {
    await replyTelegram(chatId,
      '🤖 Commands:\n\n' +
      '/addship <mmsi>\n' +
      '/addship <mmsi> <name>\n' +
      '/addship <mmsi> <name> <lat> <lon> <radiusKm> [zoneLabel]\n' +
      '/addship <mmsi> <name> <savedZoneLabel>\n' +
      '/addship <name> <lat> <lon> <radiusKm> [zoneLabel]\n' +
      '/addship <name> <savedZoneLabel>\n' +
      '  Add a new ship or add a zone to an existing ship by name.\n\n' +
      '/removeship <mmsi>\n' +
      '  Stop tracking a ship.\n\n' +
      '/updatemmsi <name> <newMmsi>\n' +
      '  Update the MMSI of an existing ship.\n\n' +
      '/setcallsign <name_or_mmsi> <callsign>\n' +
      '/setcallsign <name_or_mmsi> clear\n' +
      '  Set or clear the AIS callsign for a ship.\n' +
      '  Enables MMSI-change detection via callsign + name matching.\n\n' +
      '/addaltname <name_or_mmsi> <altName>\n' +
      '  Add an alternative vessel name for MMSI-change detection.\n\n' +
      '/addzone <lat> <lon> <radiusKm> <zoneLabel>\n' +
      '  Save a named zone for reuse with /addship.\n\n' +
      '/listships\n' +
      '  List all tracked ships and their zones.\n\n' +
      '/help\n' +
      '  Show this message.'
    );
    return;
  }

  // ── Unknown command ──────────────────────────────────────────────────────────
  await replyTelegram(chatId, '❓ Unknown command. Use /help to see available commands.');
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
for (const ship of SHIPS) scheduleAisCheck(String(ship.mmsi), TG_CHAT_ID);
connect();
pollTelegram();
