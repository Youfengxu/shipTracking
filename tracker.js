require('dotenv').config({ override: true });
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
const STATE_FILE       = path.join(__dirname, 'state.json');
const SUSPECTS_FILE    = path.join(__dirname, 'suspects.json');
const AIS_CHECK_WINDOW = 30 * 60 * 1000; // 30 min — wait before "AIS still off" message

const LLAMA_URL       = process.env.LLAMA_URL; // e.g. http://127.0.0.1:11435
const LLAMA_MODEL     = process.env.LLAMA_MODEL || 'llama3';

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

function takeShipsBackup() {
  lastShipsState = JSON.parse(JSON.stringify(SHIPS)); // Deep copy current state
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

// ── Suspects registry ─────────────────────────────────────────────────────────
// Each entry: { suspectedMmsi, trackedMmsi, trackedName, reason, lat, lon, detectedAt }

let SUSPECTS = []; // array, ordered oldest-first

function loadSuspects() {
  try {
    SUSPECTS = JSON.parse(fs.readFileSync(SUSPECTS_FILE, 'utf8'));
    log(`Loaded ${SUSPECTS.length} suspect(s) from suspects.json`);
  } catch {
    SUSPECTS = [];
  }
}

function saveSuspects() {
  fs.writeFileSync(SUSPECTS_FILE, JSON.stringify(SUSPECTS, null, 2));
}

function isSuspectKnown(trackedMmsi, suspectedMmsi) {
  return SUSPECTS.some(s => s.suspectedMmsi === String(suspectedMmsi));
}

function addSuspect(trackedShip, suspectedMmsi, reason, lat, lon) {
  SUSPECTS.push({
    suspectedMmsi: String(suspectedMmsi),
    trackedMmsi:   String(trackedShip.mmsi),
    trackedName:   trackedShip.name || `MMSI ${trackedShip.mmsi}`,
    reason,
    lat,
    lon,
    detectedAt:    new Date().toISOString(),
  });
  saveSuspects();
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.lastPosition) {
        for (const [mmsi, pos] of Object.entries(data.lastPosition)) {
          lastPosition.set(mmsi, pos);
        }
      }
      if (data.insideZone && Array.isArray(data.insideZone)) {
        for (const key of data.insideZone) insideZone.add(key);
      }
      log(`Loaded state from state.json: ${lastPosition.size} positions, ${insideZone.size} active zones`);
    }
  } catch (err) {
    log(`Error loading state.json: ${err.message}`);
  }
}

function saveState() {
  try {
    const data = {
      lastPosition: Object.fromEntries(lastPosition),
      insideZone: Array.from(insideZone),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Error saving state.json: ${err.message}`);
  }
}

let saveStateTimer = null;
function saveStateThrottled() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveState, 5000);
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
let   lastShipsState   = null;      // Backup for /undo functionality
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

// Find a ship by MMSI or name (case-insensitive partial match on name)
function findShip(query) {
  const q = query.trim();
  // Exact MMSI
  if (SHIP_MAP[q]) return SHIP_MAP[q];
  // Case-insensitive name
  const lower = q.toLowerCase();
  return SHIPS.find(s => s.name && s.name.toLowerCase().includes(lower)) || null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// ── Beta: Natural Language Processing (Llama) ───────────────────────────────

async function translateIntentWithLlama(text) {
  const LLAMA_URL = process.env.LLAMA_URL;
  const LLAMA_MODEL = process.env.LLAMA_MODEL || 'llama-model';
  if (!LLAMA_URL) return null;

  log(`[llama] Heartbeat: Processing NL query from user: "${text}" (Model: ${LLAMA_MODEL})`);

  // Provide Name -> MMSI mapping for the LLM
  const shipContext = SHIPS.map(s => `${s.name || 'Unnamed'}: ${s.mmsi}`).join(', ');
  const zoneNames = Object.keys(ZONES).join(', ');

  const systemPrompt = `You are the Command Orchestrator for an AIS Ship Tracker.
Translate user requests into system commands. 

CURRENT ASSETS (Name: MMSI):
${shipContext || 'None'}

DEFINED ZONES:
${zoneNames || 'None'}

TOOLS:
- /status: Overview of all tracked ships.
- /ping <ship>: Status of ONE specific ship (name or MMSI).
- /addship <mmsi> [name]: Track NEW ship.
- /removeship <ship>: Stop tracking. Use MMSI if known.
- /setname <mmsi> <new_name>: RENAME an existing ship. ALWAYS find the MMSI for the ship first!
- /addzone <ship> <zone>: Link ship to zone.
- /rmzone <ship> <zone>: Remove zone from ship.
- /listships: List tracked ships.
- /listzones: List all zones.
- /undo: REVERT the last change. Use for "undo", "go back", "revert", "oops".
- /whoareyou: Identity easter egg.
- /whoisthebest: Praise easter egg.

RULES:
1. ALWAYS use the MMSI for /setname. Look it up in CURRENT ASSETS.
2. Output ONLY a JSON ARRAY of objects with "command" and "args".
3. No preamble.

Example 1: "Rename RMN Warship 174 to Warship" (if RMN Warship 174 is 533003000)
Response: [{"command": "/setname", "args": "533003000 Warship"}]

Example 2: "Stop tracking the USS Tulsa" (if USS Tulsa is 368926114)
Response: [{"command": "/removeship", "args": "368926114"}]

Example 3: "who are you?"
Response: [{"command": "/whoareyou", "args": ""}]

Example 4: "who is the best?"
Response: [{"command": "/whoisthebest", "args": ""}]`;

  try {
    const response = await axios.post(`${LLAMA_URL}/v1/chat/completions`, {
      model:  LLAMA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `User query: "${text}"` },
      ],
      stream: false,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
    }, { timeout: 90000 });

    const raw = response.data.choices?.[0]?.message?.content ?? '';
    log(`[llama] Raw Response: ${raw}`);
    let result;
    try {
      result = JSON.parse(raw || '[]');
    } catch (e) {
      log(`[llama] JSON Parse Error: ${e.message}. Content: ${raw}`);
      return { error: 'The model returned an invalid response format.' };
    }
    
    // Normalize single object to array
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      result = [result];
    }

    if (Array.isArray(result) && result.length > 0) {
      const valid = result.filter(item => item && item.command && item.command !== 'UNKNOWN');
      if (valid.length > 0) {
        log(`[llama] Success: mapped to ${valid.length} command(s)`);
        return valid;
      }
    }
    log(`[llama] Warning: No valid commands found in: ${JSON.stringify(result)}`);
    return { error: 'I understood the words, but couldn\'t map them to a specific command.' };
  } catch (err) {
    if (err.response?.status === 404) {
      log(`[llama] Error: Model "${LLAMA_MODEL}" not found on Llama server at ${LLAMA_URL}`);
      return { error: `Model "${LLAMA_MODEL}" not found. Please check your .env or run "llama pull ${LLAMA_MODEL}".` };
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log(`[llama] Error (status=${err.response?.status ?? 'none'}): ${detail}`);
    return { error: `Llama error: ${detail}` };
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

async function replyTelegram(chatId, text, parseMode) {
  if (!TG_TOKEN) return;
  try {
    const body = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, body);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log(`Telegram reply error: ${detail}`);
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
  // Already recorded — silently ignore, no repeat alert
  if (isSuspectKnown(ship.mmsi, newMmsi)) return;

  // In-memory cooldown guards against duplicate fires before suspects.json is written
  const key = `${ship.mmsi}::${newMmsi}`;
  const now = Date.now();
  if (mmsiChangeAlerts.has(key) && now - mmsiChangeAlerts.get(key) < 3_600_000) return;
  mmsiChangeAlerts.set(key, now);

  // Persist to suspects list before alerting
  addSuspect(ship, newMmsi, reason, lat, lon);

  const label    = ship.name || `MMSI ${ship.mmsi}`;
  const location = await reverseGeocode(lat, lon);
  const locLine  = location ? `\n📍 ${location}` : '';
  const plain    = `⚠️ POSSIBLE MMSI CHANGE\n🚢 ${label} (tracked MMSI ${ship.mmsi})\n📡 Spotted MMSI: ${newMmsi} (${reason})\n🌐 ${lat.toFixed(4)}, ${lon.toFixed(4)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html     = `⚠️ POSSIBLE MMSI CHANGE\n🚢 ${label} (tracked MMSI ${ship.mmsi})\n📡 Spotted MMSI: ${newMmsi} (${reason})\n🌐 ${coordHtml(lat, lon)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'possible_mmsi_change', trackedMmsi: ship.mmsi, newMmsi, shipName: label, reason, lat, lon }, html);
}

// ── AIS-off follow-up timer ───────────────────────────────────────────────────

function scheduleAisCheck(mmsi, chatId) {
  const targetId = chatId || TG_CHAT_ID;
  if (!targetId) return;

  clearPendingAisCheck(mmsi);
  const timer = setTimeout(async () => {
    pendingAisChecks.delete(mmsi);
    const ship = SHIP_MAP[mmsi];
    if (!ship) return;
    const label = ship.name || `MMSI ${mmsi}`;
    const mins  = Math.round(AIS_CHECK_WINDOW / 60000);
    await replyTelegram(targetId,
      `⚠️ NO AIS SIGNAL DETECTED\n` +
      `🚢 ${label} (MMSI ${mmsi})\n` +
      `📵 No position report received in the last ${mins} minutes.\n` +
      `   AIS may be off or out of terrestrial coverage.\n` +
      `   You will be alerted automatically when it comes online.`
    );
    log(`AIS check timeout for ${label}`);
  }, AIS_CHECK_WINDOW);
  pendingAisChecks.set(mmsi, { timer, chatId: targetId });
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
  const now  = Date.now();

  const ship = SHIP_MAP[mmsi];

  if (ship) {
    // ── Update position and check AIS-on status ──
    const prev        = lastPosition.get(mmsi);
    const lastSeen    = prev ? new Date(prev.ts).getTime() : 0;
    const wasOff      = !prev || (now - lastSeen) > STALE_MS;

    lastPosition.set(mmsi, { lat, lon, ts: new Date().toISOString() });
    saveStateThrottled();

    if (wasOff) {
      clearPendingAisCheck(mmsi);
      // Suppress alert if we saw it very recently (e.g. restart grace) 
      // or if we just started up and it was already in state.json
      const recentlySeen = (now - lastSeen) < (5 * 60 * 1000); 
      if (!recentlySeen && (now - startupTime > STARTUP_GRACE_MS)) {
        await notifyAisOn(ship, { lat, lon });
      }
    }

    // Reset the "gone dark" timer
    scheduleAisCheck(mmsi);

    // ── Zone Entry/Exit checks ──
    const zones = ship.zones || [];
    for (const zone of zones) {
      const distKm   = haversineKm(zone.lat, zone.lon, lat, lon);
      const inZone   = distKm <= zone.radiusKm;
      const stateKey = `${mmsi}::${zone.label}`;

      // log(`${displayName} — ${distKm.toFixed(2)} km from "${zone.label}"`);

      if (inZone && !insideZone.has(stateKey)) {
        insideZone.add(stateKey);
        saveStateThrottled();
        await notifyEntry(ship, zone, { lat, lon, distKm });
      } else if (!inZone && insideZone.has(stateKey)) {
        insideZone.delete(stateKey);
        saveStateThrottled();
        await notifyExit(ship, zone, { lat, lon, distKm });
      }
    }
  }

  // ── ShipStaticData: name/callsign matching against all enhanced-tracked ships ──
  if (msg.MessageType === 'ShipStaticData') {
    const sd         = msg.Message?.ShipStaticData;
    const rxName     = (sd?.Name || meta.ShipName || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const rxCallsign = (sd?.CallSign || '').trim().toUpperCase();

    if (rxName || rxCallsign) {
      // Auto-populate name/callsign for tracked ships that are missing them
      if (ship && (!ship.name || !ship.callsign)) {
        let updated = false;
        if (rxName && !ship.name) {
          ship.name = aisNameToDisplay(rxName);
          updated = true;
        }
        if (rxCallsign && !ship.callsign) {
          ship.callsign = rxCallsign;
          updated = true;
        }
        if (updated) {
          saveShips();
          const label = ship.name || `MMSI ${mmsi}`;
          log(`Auto-populated ${label} (MMSI ${mmsi}) — name=${ship.name || '–'} callsign=${ship.callsign || '–'}`);
          const lines = [`📋 Ship details auto-populated`, `🚢 MMSI ${mmsi}`];
          if (ship.name)     lines.push(`   Name: ${ship.name}`);
          if (ship.callsign) lines.push(`   Callsign: ${ship.callsign}`);
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
    }
  }
}

// ── Telegram command handlers ─────────────────────────────────────────────────

async function cmdHelp(chatId) {
  const text = [
    '🚢 <b>Ship Tracker Commands</b>',
    '',
    '<b>Status</b>',
    '/status — last known position of all tracked ships',
    '/ping &lt;name or mmsi&gt; — position of one specific ship',
    '',
    '<b>Lists</b>',
    '/listships — all tracked ships with zones',
    '/listzones — all named zones with coordinates',
    '',
    '<b>Ships</b>',
    '/addship &lt;mmsi&gt; [name] — start tracking a new ship',
    '/removeship &lt;name or mmsi&gt; — stop tracking a ship',
    '/setname &lt;mmsi&gt; &lt;name&gt; — update a ship\'s display name',
    '',
    '<b>Enhanced tracking</b>',
    '/setcallsign &lt;ship&gt; &lt;callsign&gt; — set callsign (use "none" to clear)',
    '/addaltname &lt;ship&gt; &lt;name&gt; — add an alternate broadcast name',
    '/rmaltname &lt;ship&gt; &lt;name&gt; — remove an alternate broadcast name',
    '/listsuspect — list all recorded suspect MMSIs',
    '/clearsuspect &lt;mmsi&gt; — remove a suspect MMSI from the list',
    '',
    '<b>Zones</b>',
    '/addzone &lt;ship&gt; &lt;zone&gt; [radiusKm] — add a zone to a ship',
    '  zone can be a named zone from /listzones, or lat,lon,radius',
    '/rmzone &lt;ship&gt; &lt;zone&gt; — remove a zone from a ship',
    '',
    '<b>Examples</b>',
    '/ping USS Tulsa',
    '/addship 368926114 USS Tulsa',
    '/setcallsign "USS Tulsa" NFGP',
    '/addaltname "USS Tulsa" TULSA',
    '/addzone "USS Tulsa" "Singapore Straits"',
    '/addzone "USS Tulsa" "Sembawang Naval Base" 3',
    '/rmzone "USS Tulsa" "Singapore Straits"',
    '/removeship USS Tulsa',
  ].join('\n');
  await replyTelegram(chatId, text, 'HTML');
}

async function cmdStatus(chatId) {
  if (SHIPS.length === 0) {
    await replyTelegram(chatId, 'No ships are being tracked. Use /addship to add one.');
    return;
  }
  const now = Date.now();
  const lines = ['🌐 <b>Ship Positions</b>\n'];
  for (const ship of SHIPS) {
    const mmsi  = String(ship.mmsi);
    const label = ship.name || `MMSI ${mmsi}`;
    const pos   = lastPosition.get(mmsi);
    if (!pos) {
      lines.push(`🚢 ${label} — <i>never seen since tracker started</i>`);
      continue;
    }
    const ageMins = Math.round((now - new Date(pos.ts).getTime()) / 60000);
    const ageStr  = ageMins < 2 ? 'just now' : `${ageMins}m ago`;
    const online  = ageMins < 30;
    const icon    = online ? '🟢' : '👻';
    const status  = online ? '' : ' (gone dark)';
    const zones   = (ship.zones || [])
      .filter(z => z.label && insideZone.has(`${mmsi}::${z.label}`))
      .map(z => z.label);
    const zoneStr = zones.length > 0 ? ` | 📍 ${zones.join(', ')}` : '';
    lines.push(
      `${icon} <a href="${mapsUrl(pos.lat, pos.lon)}">${label}</a> — ` +
      `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}${status} (${ageStr})${zoneStr}`
    );
  }
  await replyTelegram(chatId, lines.join('\n'), 'HTML');
}

async function cmdPing(chatId, args) {
  if (!args) {
    await replyTelegram(chatId, 'Usage: /ping <name or mmsi>');
    return;
  }
  const ship = findShip(args);
  if (!ship) {
    await replyTelegram(chatId, `No ship found matching "${args}". Use /listships to see all tracked ships.`);
    return;
  }
  const mmsi  = String(ship.mmsi);
  const label = ship.name || `MMSI ${mmsi}`;
  const pos   = lastPosition.get(mmsi);
  if (!pos) {
    await replyTelegram(chatId,
      `🚢 ${label} (MMSI ${mmsi})\n📵 <i>Never seen since tracker started.</i>`,
      'HTML'
    );
    return;
  }
  const ageMins = Math.round((Date.now() - new Date(pos.ts).getTime()) / 60000);
  const ageStr  = ageMins < 2 ? 'just now' : `${ageMins}m ago`;
  const online  = ageMins < 30;
  const icon    = online ? '🟢' : '👻';
  const status  = online ? '' : ' (Gone Dark)';
  const zones   = (ship.zones || [])
    .filter(z => z.label && insideZone.has(`${mmsi}::${z.label}`))
    .map(z => z.label);
  const zoneStr = zones.length > 0 ? `\n📍 In zone: ${zones.join(', ')}` : '';
  const location = await reverseGeocode(pos.lat, pos.lon);
  const locStr   = location ? `\n📍 ${location}` : '';
  await replyTelegram(chatId,
    `${icon} <b>${label}${status}</b> (MMSI ${mmsi})\n` +
    `🌐 <a href="${mapsUrl(pos.lat, pos.lon)}">${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}</a>${locStr}${zoneStr}\n` +
    `🕐 ${new Date(pos.ts).toUTCString()} (${ageStr})`,
    'HTML'
  );
}

async function cmdListShips(chatId) {
  if (SHIPS.length === 0) {
    await replyTelegram(chatId, 'No ships are being tracked. Use /addship to add one.');
    return;
  }
  const lines = [`📋 <b>Tracked Ships (${SHIPS.length})</b>\n`];
  for (const ship of SHIPS) {
    const label = ship.name || `MMSI ${ship.mmsi}`;
    const zones = (ship.zones || []).map(z => z.label || `${z.lat},${z.lon} r=${z.radiusKm}km`);
    const zoneStr = zones.length > 0 ? zones.join(', ') : 'AIS-on alerts only';
    lines.push(`🚢 ${label} — MMSI: <code>${ship.mmsi}</code>\n   Zones: ${zoneStr}`);
  }
  await replyTelegram(chatId, lines.join('\n'), 'HTML');
}

async function cmdListZones(chatId) {
  const keys = Object.keys(ZONES);
  if (keys.length === 0) {
    await replyTelegram(chatId, 'No named zones defined. You can add inline zones with /addzone.');
    return;
  }
  const lines = [`📍 <b>Named Zones (${keys.length})</b>\n`];
  for (const key of keys) {
    const z = ZONES[key];
    lines.push(`📌 <b>${z.label}</b> — ${z.lat}, ${z.lon} | r=${z.radiusKm} km`);
  }
  await replyTelegram(chatId, lines.join('\n'), 'HTML');
}

async function cmdAddShip(chatId, args) {
  if (!args) {
    await replyTelegram(chatId, 'Usage: /addship <mmsi> [name]');
    return;
  }
  const parts = args.trim().split(/\s+/);
  const mmsi  = parts[0];
  if (!/^\d{6,10}$/.test(mmsi)) {
    await replyTelegram(chatId, `Invalid MMSI "${mmsi}". Must be 6–10 digits.`);
    return;
  }
  if (SHIP_MAP[mmsi]) {
    const existing = SHIP_MAP[mmsi];
    await replyTelegram(chatId, `MMSI ${mmsi} is already tracked as "${existing.name || mmsi}".`);
    return;
  }
  
  takeShipsBackup();
  const name = parts.slice(1).join(' ') || undefined;
  const ship = { mmsi, zones: [] };
  if (name) ship.name = name;
  SHIPS.push(ship);
  SHIP_MAP[mmsi] = ship;
  saveShips();
  reconnectWebSocket();
  const label = name || `MMSI ${mmsi}`;
  await replyTelegram(chatId,
    `✅ Added ${label}.\nUse /addzone "${label}" "<zone>" to add geo-fence zones.`
  );
  log(`Added ship: ${label} (${mmsi})`);
}

async function cmdRemoveShip(chatId, args) {
  if (!args) {
    await replyTelegram(chatId, 'Usage: /removeship <name or mmsi>');
    return;
  }
  const ship = findShip(args.trim());
  if (!ship) {
    await replyTelegram(chatId, `No ship found matching "${args}". Use /listships to see all.`);
    return;
  }
  
  takeShipsBackup();
  const mmsi  = String(ship.mmsi);
  const label = ship.name || `MMSI ${mmsi}`;
  SHIPS = SHIPS.filter(s => String(s.mmsi) !== mmsi);
  delete SHIP_MAP[mmsi];
  
  // Note: We deliberately do NOT delete from lastPosition here.
  // This allows the ship's historical location to survive if it is re-added
  // and ensures the tracker differentiates between "never seen" and "gone dark".

  // Clean up insideZone keys for this ship
  for (const key of insideZone) {
    if (key.startsWith(`${mmsi}::`)) insideZone.delete(key);
  }
  saveShips();
  saveState();
  reconnectWebSocket();
  await replyTelegram(chatId, `✅ Removed ${label} from tracking.`);
  log(`Removed ship: ${label} (${mmsi})`);
}

async function cmdSetName(chatId, args) {
  if (!args || !args.trim().includes(' ')) {
    await replyTelegram(chatId, 'Usage: /setname <mmsi> <new name>');
    return;
  }
  const parts = args.trim().split(/\s+/);
  const mmsi  = parts[0];
  const name  = parts.slice(1).join(' ');
  const ship  = SHIP_MAP[mmsi];
  if (!ship) {
    await replyTelegram(chatId, `No ship found with MMSI ${mmsi}. Use /listships to see all.`);
    return;
  }
  
  takeShipsBackup();
  const oldName = ship.name || `MMSI ${mmsi}`;
  const conflict = SHIPS.find(
    s => String(s.mmsi) !== mmsi && s.name && s.name.toLowerCase() === name.toLowerCase()
  );
  if (conflict) {
    await replyTelegram(chatId,
      `⚠️ "${name}" is already the name of MMSI ${conflict.mmsi}. Choose a different name.`
    );
    return;
  }
  ship.name = name;
  saveShips();
  await replyTelegram(chatId, `✅ Renamed ${oldName} → ${name}`);
  log(`Renamed MMSI ${mmsi}: ${oldName} → ${name}`);
}

async function cmdSetCallsign(chatId, args) {
  if (!args || !args.trim().includes(' ')) {
    await replyTelegram(chatId, 'Usage: /setcallsign <name or mmsi> <callsign>\nUse "none" to clear.');
    return;
  }
  const tokens = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(args)) !== null) tokens.push(m[1] ?? m[2]);

  const ship = findShip(tokens[0]);
  if (!ship) {
    await replyTelegram(chatId, `No ship found matching "${tokens[0]}".`);
    return;
  }
  
  takeShipsBackup();
  const label     = ship.name || `MMSI ${ship.mmsi}`;
  const callsign  = tokens.slice(1).join(' ').toUpperCase();
  if (callsign === 'NONE') {
    delete ship.callsign;
    saveShips();
    await replyTelegram(chatId, `✅ Cleared callsign for ${label}.`);
  } else {
    ship.callsign = callsign;
    saveShips();
    await replyTelegram(chatId, `✅ Set callsign for ${label} → ${callsign}`);
  }
  log(`Callsign updated: ${label} (${ship.mmsi}) → ${ship.callsign || 'cleared'}`);
}

async function cmdAddAltName(chatId, args) {
  if (!args) {
    await replyTelegram(chatId, 'Usage: /addaltname <name or mmsi> <alternate name>');
    return;
  }
  const tokens = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(args)) !== null) tokens.push(m[1] ?? m[2]);

  if (tokens.length < 2) {
    await replyTelegram(chatId, 'Provide both ship and alternate name.');
    return;
  }
  const ship = findShip(tokens[0]);
  if (!ship) {
    await replyTelegram(chatId, `No ship found matching "${tokens[0]}".`);
    return;
  }
  
  takeShipsBackup();
  const altName = tokens.slice(1).join(' ').toUpperCase();
  if (!ship.altNames) ship.altNames = [];
  if (ship.altNames.map(n => n.toUpperCase()).includes(altName)) {
    await replyTelegram(chatId, `"${altName}" is already in the alt names list for ${ship.name || ship.mmsi}.`);
    return;
  }
  ship.altNames.push(altName);
  saveShips();
  const label = ship.name || `MMSI ${ship.mmsi}`;
  await replyTelegram(chatId, `✅ Added alt name "${altName}" to ${label}.\nAll alt names: ${ship.altNames.join(', ')}`);
  log(`Alt name added: ${label} (${ship.mmsi}) += ${altName}`);
}

async function cmdRmAltName(chatId, args) {
  if (!args) {
    await replyTelegram(chatId, 'Usage: /rmaltname <name or mmsi> <alternate name>');
    return;
  }
  const tokens = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(args)) !== null) tokens.push(m[1] ?? m[2]);

  if (tokens.length < 2) {
    await replyTelegram(chatId, 'Provide both ship and alternate name to remove.');
    return;
  }
  const ship = findShip(tokens[0]);
  if (!ship) {
    await replyTelegram(chatId, `No ship found matching "${tokens[0]}".`);
    return;
  }
  
  takeShipsBackup();
  const altName = tokens.slice(1).join(' ').toUpperCase();
  const before  = (ship.altNames || []).length;
  ship.altNames = (ship.altNames || []).filter(n => n.toUpperCase() !== altName);
  if (ship.altNames.length === before) {
    await replyTelegram(chatId, `"${altName}" not found in alt names for ${ship.name || ship.mmsi}.`);
    return;
  }
  if (ship.altNames.length === 0) delete ship.altNames;
  saveShips();
  const label = ship.name || `MMSI ${ship.mmsi}`;
  const remaining = ship.altNames?.join(', ') || 'none';
  await replyTelegram(chatId, `✅ Removed alt name "${altName}" from ${label}.\nRemaining: ${remaining}`);
  log(`Alt name removed: ${label} (${ship.mmsi}) -= ${altName}`);
}

// /addzone <ship> <zone_label_or_coords> [radiusKm]
// Supports:
//   /addzone "USS Tulsa" "Singapore Straits"          — named zone from zones.json
//   /addzone "USS Tulsa" "Singapore Straits" 25       — override radius
//   /addzone "USS Tulsa" 1.265,103.837,35             — inline lat,lon,radius
async function cmdAddZone(chatId, args) {
  if (!args) {
    await replyTelegram(chatId,
      'Usage:\n' +
      '  /addzone <ship> <zone name> [radiusKm]\n' +
      '  /addzone <ship> <lat,lon,radiusKm>'
    );
    return;
  }

  // Parse quoted or unquoted tokens: "foo bar" baz "qux"
  const tokens = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(args)) !== null) tokens.push(m[1] ?? m[2]);

  if (tokens.length < 2) {
    await replyTelegram(chatId, 'Provide at least a ship and a zone. Use /help for syntax.');
    return;
  }

  const shipQuery = tokens[0];
  const ship = findShip(shipQuery);
  if (!ship) {
    await replyTelegram(chatId, `No ship found matching "${shipQuery}". Use /listships to see all.`);
    return;
  }
  
  takeShipsBackup();

  const zoneArg   = tokens[1];
  const radiusArg = tokens[2] ? parseFloat(tokens[2]) : null;

  let zone;

  // Try inline lat,lon,radius format
  const coordMatch = zoneArg.match(/^(-?\d+\.?\d*),(-?\d+\.?\d*),(\d+\.?\d*)$/);
  if (coordMatch) {
    const lat      = parseFloat(coordMatch[1]);
    const lon      = parseFloat(coordMatch[2]);
    const radiusKm = parseFloat(coordMatch[3]);
    zone = { label: `${lat},${lon}`, lat, lon, radiusKm };
  } else {
    // Named zone from zones.json
    const named = resolveZoneLabel(zoneArg);
    if (!named) {
      await replyTelegram(chatId,
        `Zone "${zoneArg}" not found in named zones.\n` +
        `Use /listzones to see available zones, or provide lat,lon,radiusKm directly.`
      );
      return;
    }
    zone = { ...named };
    if (radiusArg && !isNaN(radiusArg)) zone.radiusKm = radiusArg;
  }

  // Check if zone with same label already exists on this ship
  const existing = (ship.zones || []).findIndex(
    z => z.label.toLowerCase() === zone.label.toLowerCase()
  );
  if (existing !== -1) {
    ship.zones[existing] = zone;
    saveShips();
    reconnectWebSocket();
    await replyTelegram(chatId,
      `✅ Updated zone "${zone.label}" on ${ship.name || ship.mmsi} (r=${zone.radiusKm} km).`
    );
  } else {
    ship.zones.push(zone);
    saveShips();
    reconnectWebSocket();
    await replyTelegram(chatId,
      `✅ Added zone "${zone.label}" to ${ship.name || ship.mmsi} (r=${zone.radiusKm} km).`
    );
  }
  log(`Zone "${zone.label}" added/updated on ${ship.name || ship.mmsi} (${ship.mmsi})`);
}

async function cmdRmZone(chatId, args) {
  if (!args) {
    await replyTelegram(chatId, 'Usage: /rmzone <ship> <zone name>');
    return;
  }
  const tokens = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(args)) !== null) tokens.push(m[1] ?? m[2]);

  if (tokens.length < 2) {
    await replyTelegram(chatId, 'Provide both ship and zone name. Use /help for syntax.');
    return;
  }

  const ship = findShip(tokens[0]);
  if (!ship) {
    await replyTelegram(chatId, `No ship found matching "${tokens[0]}".`);
    return;
  }
  
  takeShipsBackup();
  const zoneLabel = tokens.slice(1).join(' ');
  const before    = (ship.zones || []).length;
  ship.zones      = (ship.zones || []).filter(
    z => z.label.toLowerCase() !== zoneLabel.toLowerCase()
  );
  if (ship.zones.length === before) {
    await replyTelegram(chatId,
      `Zone "${zoneLabel}" not found on ${ship.name || ship.mmsi}.\n` +
      `Use /listships to see current zones.`
    );
    return;
  }
  // Clean up insideZone state for removed zone
  insideZone.delete(`${ship.mmsi}::${zoneLabel}`);
  saveShips();
  saveState();
  reconnectWebSocket();
  await replyTelegram(chatId,
    `✅ Removed zone "${zoneLabel}" from ${ship.name || ship.mmsi}.`
  );
  log(`Zone "${zoneLabel}" removed from ${ship.name || ship.mmsi} (${ship.mmsi})`);
}

async function cmdListSuspect(chatId) {
  if (SUSPECTS.length === 0) {
    await replyTelegram(chatId, '✅ No suspect MMSIs recorded.');
    return;
  }
  const header = `🔍 <b>Suspect MMSIs (${SUSPECTS.length})</b>\n`;
  const footer = '\nUse /clearsuspect &lt;mmsi&gt; to remove a false positive.';
  const LIMIT  = 3800; // leave headroom under Telegram's 4096-char cap

  let chunk  = header;
  let page   = 1;
  for (const s of SUSPECTS) {
    const when  = new Date(s.detectedAt).toUTCString();
    const entry =
      `⚠️ <code>${s.suspectedMmsi}</code> → ${s.trackedName} (${s.trackedMmsi})\n` +
      `   Reason: ${s.reason}\n` +
      `   Detected: ${when}\n`;

    if (chunk.length + entry.length + footer.length > LIMIT) {
      await replyTelegram(chatId, chunk + footer, 'HTML');
      chunk = `🔍 <b>Suspect MMSIs (cont. page ${++page})</b>\n`;
    }
    chunk += entry;
  }
  await replyTelegram(chatId, chunk + footer, 'HTML');
}

async function cmdClearSuspect(chatId, args) {
  if (!args) {
    await replyTelegram(chatId, 'Usage: /clearsuspect <suspected mmsi>');
    return;
  }
  const mmsi   = args.trim();
  const before = SUSPECTS.length;
  SUSPECTS     = SUSPECTS.filter(s => s.suspectedMmsi !== mmsi);
  if (SUSPECTS.length === before) {
    await replyTelegram(chatId, `MMSI ${mmsi} not found in suspect list.`);
    return;
  }
  saveSuspects();
  // Also clear in-memory cooldown so it can be re-detected if it comes back
  for (const key of mmsiChangeAlerts.keys()) {
    if (key.endsWith(`::${mmsi}`)) mmsiChangeAlerts.delete(key);
  }
  await replyTelegram(chatId, `✅ Removed MMSI ${mmsi} from suspect list. It will alert again if re-detected.`);
  log(`Suspect MMSI ${mmsi} cleared from list`);
}

async function cmdUndo(chatId) {
  if (!lastShipsState) {
    await replyTelegram(chatId, '❌ Nothing to undo or backup already restored.');
    return;
  }
  SHIPS = lastShipsState;
  lastShipsState = null; // Clear backup after restoring
  SHIP_MAP = {};
  for (const s of SHIPS) SHIP_MAP[String(s.mmsi)] = s;
  saveShips(true); // Save restored state, but don't backup the backup
  reconnectWebSocket();
  await replyTelegram(chatId, '✅ Last change to ships has been undone.');
  log('Undo performed: restored previous ship state');
}

// ── Telegram update dispatcher ────────────────────────────────────────────────

let BOT_USERNAME = '';

/**
 * Dispatches a specific slash command to its handler.
 * Reused by both direct slash commands and the LLM intent translator.
 */
async function handleCommand(chatId, rawCmd, args, fromName) {
  // Normalize command
  const cmd = rawCmd.toLowerCase();
  log(`[tg] Executing: ${cmd} ${args || ''} (from: ${fromName || 'system'})`);

  switch (cmd) {
    case '/help':        return cmdHelp(chatId);
    case '/status':      return cmdStatus(chatId);
    case '/ping':        return cmdPing(chatId, args);
    case '/undo':        return cmdUndo(chatId);
    case '/listships':   return cmdListShips(chatId);
    case '/listzones':   return cmdListZones(chatId);
    case '/addship':     return cmdAddShip(chatId, args);
    case '/removeship':  return cmdRemoveShip(chatId, args);
    case '/setname':      return cmdSetName(chatId, args);
    case '/setcallsign':  return cmdSetCallsign(chatId, args);
    case '/addaltname':   return cmdAddAltName(chatId, args);
    case '/rmaltname':    return cmdRmAltName(chatId, args);
    case '/listsuspect':  return cmdListSuspect(chatId);
    case '/clearsuspect': return cmdClearSuspect(chatId, args);
    case '/addzone':      return cmdAddZone(chatId, args);
    case '/rmzone':      return cmdRmZone(chatId, args);
    case '/whoareyou':   return replyTelegram(chatId, 'I am the GOAT');
    case '/whoisthebest': return replyTelegram(chatId, 'The Supreme Leader!');
    default:
      // If it's a direct slash command that we don't know, reply with help
      if (cmd.startsWith('/')) {
        await replyTelegram(chatId, `Unknown command. Send /help for a list of commands.`);
      }
  }
}

async function handleTelegramUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const text   = (msg.text || '').trim();
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';
  const fromName  = msg.from?.username || msg.from?.first_name || 'user';

  if (!text) return;

  // 1. Path A: Direct Slash Command (Bypass LLM completely)
  if (text.startsWith('/')) {
    // Strip /cmd@BotUsername → /cmd
    const parts  = text.split(/\s+/);
    const rawCmd = parts[0].replace(/@\w+$/, '').toLowerCase();
    const args   = text.slice(parts[0].length).trim() || null;
    return handleCommand(chatId, rawCmd, args, fromName);
  }

  // 2. Path B: Natural Language (Only if private or bot is mentioned)
  const botMention = `@${BOT_USERNAME}`;
  const mentioned  = text.toLowerCase().includes(botMention.toLowerCase());

  if (isPrivate || (BOT_USERNAME && mentioned)) {
    // Strip the mention if it exists
    let nlQuery = text;
    if (mentioned) {
      const regex = new RegExp(botMention, 'gi');
      nlQuery = text.replace(regex, '').trim();
    }

    if (!nlQuery) return; // ignore empty mentions

    // Call the LLM to translate the intent
    const result = await translateIntentWithLlama(nlQuery);
    log(`[tg] NL Debug: type=${Array.isArray(result) ? 'array' : typeof result} count=${Array.isArray(result) ? result.length : 'n/a'}`);

    if (Array.isArray(result) && result.length > 0) {
      for (const intent of result) {
        log(`[tg] NL Executing: ${intent.command} ${intent.args || ''}`);
        await handleCommand(chatId, intent.command, intent.args, `NL:${fromName}`);
      }
    } else if (LLAMA_URL) {
      const errorMsg = result?.error || 'I understood the words, but couldn\'t map them to a specific command.';
      log(`[tg] NL error: ${errorMsg}`);
      await replyTelegram(chatId, `⚠️ ${errorMsg}`);
    }
  }
}

// ── Telegram long-poll loop ───────────────────────────────────────────────────

async function pollTelegram() {
  if (!TG_TOKEN) {
    log('TG_TOKEN not set — Telegram polling disabled');
    return;
  }

  // Fetch bot username for @mention stripping in groups
  try {
    const me = await axios.get(`https://api.telegram.org/bot${TG_TOKEN}/getMe`, { timeout: 10000 });
    BOT_USERNAME = (me.data.result.username || '').toLowerCase();
    log(`Telegram bot: @${BOT_USERNAME} — polling for commands`);
  } catch (err) {
    log(`Failed to fetch bot info: ${err.message}`);
  }

  let offset = 0;

  while (true) {
    try {
      const resp = await axios.get(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`, {
        params: {
          offset,
          timeout:          30,
          allowed_updates:  ['message'],
        },
        timeout: 35000,
      });

      const updates = resp.data.result || [];
      for (const update of updates) {
        offset = update.update_id + 1;
        handleTelegramUpdate(update).catch(err =>
          log(`Error handling update ${update.update_id}: ${err.message}`)
        );
      }
    } catch (err) {
      if (err.code !== 'ECONNABORTED') {
        log(`Telegram poll error: ${err.message}`);
      }
      await sleep(5000);
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
    ws.send(JSON.stringify({
      APIKey:             AISSTREAM_KEY,
      BoundingBoxes:      buildBoundingBoxes(),
      // No MMSI filter — receive all vessels in bounding boxes so MMSI-prefix
      // proximity and name/callsign matching works for every tracked ship.
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }));
  });

  ws.on('message', handleAisMessage);

  ws.on('close', (code, _reason) => {
    log(`Disconnected (${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    clearInterval(ws._pingInterval);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on('error', (err) => log(`WebSocket error: ${err.message}`));

  // Keepalive: ping every 30s to detect silent drops
  ws._pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(ws._pingInterval);
    }
  }, 30000);
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
loadState();
loadSuspects();
connect();
pollTelegram();

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
    for (const ship of SHIPS) {
      const mmsi = String(ship.mmsi);
      const pos  = lastPosition.get(mmsi);
      const zones = ship.zones || [];
      const activeZones = zones
        .filter(z => z.label && insideZone.has(`${mmsi}::${z.label}`))
        .map(z => z.label);

      const isOnline = pos && (Date.now() - new Date(pos.ts).getTime()) < STALE_MS;

      out[mmsi] = {
        name:        ship.name || mmsi,
        lat:         pos ? pos.lat : null,
        lon:         pos ? pos.lon : null,
        ts:          pos ? pos.ts : null,
        insideZones: activeZones,
        hasBroadcast: !!pos,
        isOnline:     !!isOnline
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

process.on('SIGHUP', () => {
  require('dotenv').config({ override: true });
  log(`[config] Reloaded .env — LLAMA_MODEL is now "${process.env.LLAMA_MODEL}"`);
});
