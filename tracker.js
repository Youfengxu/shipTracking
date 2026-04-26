require('dotenv').config({ override: true });

const fs              = require('fs');
const log             = console.log;

// ── Module imports ────────────────────────────────────────────────────

const config        = require('./config');
const shipsModule   = require('./data/ships');
const zonesMod      = require('./data/zones');
const state         = require('./data/state');
const suspects      = require('./data/suspects');
const { sendTelegram } = require('./notifications');
const agent         = require('./agent/llama');
const ai               = require('./ais/ws');
const geo              = require('./geo');
const { handleAisMessage } = require('./ais/handler');
const axios            = require('axios');

// ── Constants ─────────────────────────────────────────────────────────

const SHIPS_FILE      = config.SHIPS_FILE;
const ZONES_FILE      = config.ZONES_FILE;
const AISSTREAM_KEY   = config.AISSTREAM_KEY;

// ── Shared state (command layer) ──────────────────────────────────────

let lastShipsBackup     = null;

// ── Helper: parse quoted/unquoted tokens ──────────────────────────────

function tokenize(str) {
  const toks = [];
  let m;
  for (const re = /"([^"]+)"|(\S+)/g; (m = re.exec(str)) !== null; ) {
    toks.push(m[1] ?? m[2]);
  }
  return toks;
}

// Greedy ship matcher: tries token[0], token[0..1], token[0..2], etc.
// Returns { ship, rest: string } or { ship: null, rest: '' }
function splitShipArgs(args) {
  const toks = tokenize(args);
  let matched = null;
  let matchLen = 0;
  for (let i = 1; i <= toks.length; i++) {
    const candidate = toks.slice(0, i).join(' ');
    const found = shipsModule.findShip(candidate);
    if (found) { matched = found; matchLen = i; }
  }
  const rest = toks.slice(matchLen).join(' ');
  return { ship: matched, rest };
}

// ── Telegram update router ───────────────────────────────────────────

async function handleTelegramUpdate(update) {
  const msg       = update.message || update.edited_message;
  if (!msg) return;

  const text      = (msg.text || '').trim();
  const chatId    = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';

  if (!text) return;

    // Path A: Direct Slash Command — bypass LLM
  if (text.startsWith('/')) {
    const rawCmd      = text.split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase();
    const args          = text.slice(text.split(/\s+/)[0].length).trim() || null;
    return handleCommand(chatId, rawCmd, args);
  }

    // Path B: Natural Language → LLM translate → execute
  const mention   = BOT_USERNAME ? `@${BOT_USERNAME}` : null;
  const mentioned = mention && text.toLowerCase().includes(mention.toLowerCase());

  let nlQuery = null;
  if (isPrivate) {
    nlQuery = text;
  } else if (mentioned && mention) {
    nlQuery = text.replace(new RegExp(mention, 'i'), '').trim();
  }

  if (nlQuery) {
    const result        = await agent.translateIntent(nlQuery);

    if (Array.isArray(result) && result.length > 0) {
      for (const intent of result) {
        log(`[tg] NL Executing: ${intent.command} ${(intent.args || '').replace(/\n/g, ' | ')}`);
        await handleCommand(chatId, intent.command, intent.args);
      }
    } else if (result?.error) {
      log(`[tg] NL error: ${result.error}`);
      await sendTelegram(chatId, `⚠️ ${result.error}`);
    }
  }
}

// ── Command dispatch ──────────────────────────────────────────────────

async function handleCommand(chatId, cmd, args) {
  log(`[tg] Executing: ${cmd} ${(args || '').replace(/\n/g, ' | ')}`);

  switch (cmd) {
    case '/help':          return cmdHelp(chatId);
    case '/status':        return cmdStatus(chatId);
    case '/ping':          return cmdPing(chatId, args);
    case '/undo':          return cmdUndo(chatId);
    case '/listships':     return cmdListShips(chatId);
    case '/listzones':     return cmdListZones(chatId);
    case '/addship':       return cmdAddShip(chatId, args);
    case '/removeship':    return cmdRemoveShip(chatId, args);
    case '/setname':        return cmdSetName(chatId, args);
    case '/setcallsign':   return cmdSetCallsign(chatId, args);
    case '/addaltname':    return cmdAddAltName(chatId, args);
    case '/rmaltname':     return cmdRmAltName(chatId, args);
    case '/listsuspect':   return cmdListSuspect(chatId);
    case '/clearsuspect':  return cmdClearSuspect(chatId, args);
    case '/addzone':       return cmdAddZone(chatId, args);
    case '/rmzone':        return cmdRmZone(chatId, args);
    case '/whoareyou':     return sendTelegram(chatId, 'I am the GOAT');
    case '/whoisthebest':  return sendTelegram(chatId, 'The Supreme Leader!');
    default:
      if (cmd.startsWith('/')) {
        await sendTelegram(chatId, 'Unknown command. Send /help for a list of commands.');
      }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Telegram Command Implementations
// These are in the entry point because they coordinate across modules.
// They should NOT be moved into individual modules to avoid circular deps.
// ═══════════════════════════════════════════════════════════════════

async function cmdHelp(chatId) {
  await sendTelegram(chatId, [
      '🚢 <b>Ship Tracker Commands</b>',
      '', '<b>Status</b>',
      '/status — last known position of all tracked ships',
      '/ping &lt;name or mmsi&gt; — position of one specific ship',
      '', '<b>Lists</b>',
      '/listships — all tracked ships with zones',
      '/listzones — all named zones with coordinates',
      '', '<b>Ships</b>',
      '/addship &lt;mmsi&gt; [name] — start tracking a new ship',
      '/removeship &lt;name or mmsi&gt; — stop tracking a ship',
      '/setname &lt;mmsi&gt; &lt;name&gt; — update a ship\'s display name',
      '', '<b>Enhanced tracking</b>',
      '/setcallsign &lt;ship&gt; &lt;callsign&gt; — set callsign (use "none" to clear)',
      '/addaltname &lt;ship&gt; &lt;name&gt; — add an alternate broadcast name',
      '/rmaltname &lt;ship&gt; &lt;name&gt; — remove an alternate broadcast name',
      '/listsuspect — list all recorded suspect MMSIs',
      '/clearsuspect &lt;mmsi&gt; — remove a suspect MMSI from the list',
      '', '<b>Zones</b>',
      '/addzone &lt;ship&gt; &lt;zone&gt; [radiusKm] — add a zone to a ship',
      '  zone can be a named zone from /listzones, or lat,lon,radius',
      '/rmzone &lt;ship&gt; &lt;zone&gt; — remove a zone from a ship',
      '', '<b>Examples</b>',
      '/ping USS Tulsa',
      '/addship 368926114 USS Tulsa',
      '/setcallsign "USS Tulsa" NFGP',
      '/addaltname "USS Tulsa" TULSA',
      '/addzone "USS Tulsa" "Singapore Straits"',
      '/addzone "USS Tulsa" "Sembawang Naval Base" 3',
      '/rmzone "USS Tulsa" "Singapore Straits"',
      '/removeship USS Tulsa',
    ].join('\n'), 'HTML');
}

async function cmdStatus(chatId) {
  const SHIPS_LIST = shipsModule.SHIPS;
  if (SHIPS_LIST.length === 0) {
    return await sendTelegram(chatId, 'No ships are being tracked. Use /addship to add one.');
  }

  const lines       = ['🌐 <b>Ship Positions</b>\n'];
  const now         = Date.now();
  for (const ship of SHIPS_LIST) {
    const mmsi        = String(ship.mmsi);
    const pos           = state.getPos(mmsi);
    if (!pos) {
      lines.push(`🚢 ${ship.name || mmsi} — <i>never seen since tracker started</i>`);
      continue;
    }
    const ageMins       = Math.round((now - new Date(pos.ts).getTime()) / 60000);
    const online        = ageMins < 30;
    const icon          = online ? '🟢' : '👻';
    const status        = online ? '' : ' (gone dark)';
    const zones         = (ship.zones || [])
         .filter(z => z.label && state.hasInside(`${mmsi}::${z.label}`))
         .map(z => z.label);
    const zoneStr       = zones.length > 0 ? ` | 📍 ${zones.join(', ')}` : '';
    lines.push(
        `${icon} <a href="${geo.mapsUrl(pos.lat, pos.lon)}">${ship.name || mmsi}</a> — ` +
        `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}${status} (${ageMins}m ago)${zoneStr}`
    );
  }
  await sendTelegram(chatId, lines.join('\n'), 'HTML');
}

async function cmdPing(chatId, args) {
  if (!args) return await sendTelegram(chatId, 'Usage: /ping <name or mmsi>');

  const ship        = shipsModule.findShip(args);
  if (!ship)       return await sendTelegram(chatId, `No ship found matching "${args}". Use /listships to see all tracked ships.`);

  const mmsi        = String(ship.mmsi);
  const label       = ship.name || mmsi;
  const pos           = state.getPos(mmsi);
  if (!pos) {
    return await sendTelegram(chatId,
        `🚢 ${label} (MMSI ${mmsi})\n📵 <i>Never seen since tracker started.</i>`, 'HTML');
  }

  const ageMins       = Math.round((Date.now() - new Date(pos.ts).getTime()) / 60000);
  const online        = ageMins < 30;
  const icon          = online ? '🟢' : '👻';
  const status        = online ? '' : ' (Gone Dark)';
  const zones         = (ship.zones || [])
       .filter(z => z.label && state.hasInside(`${mmsi}::${z.label}`))
       .map(z => z.label);
  const zoneStr       = zones.length > 0 ? `\n📍 In zone: ${zones.join(', ')}` : '';

  const location        = await geo.reverseGeocode(pos.lat, pos.lon);
  const locStr          = location ? `\n📍 ${location}` : '';

  await sendTelegram(chatId,
       `${icon} <b>${label}${status}</b> (MMSI ${mmsi})\n` +
       `🌐 <a href="${geo.mapsUrl(pos.lat, pos.lon)}">${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}</a>${locStr}${zoneStr}\n` +
       `🕐 ${new Date(pos.ts).toUTCString()} (${ageMins}m ago)`, 'HTML');
}

async function cmdListShips(chatId) {
  const SHIPS_LIST = shipsModule.SHIPS;
  if (SHIPS_LIST.length === 0) {
    return await sendTelegram(chatId, 'No ships are being tracked. Use /addship to add one.');
  }

  const lines         = [`📋 <b>Tracked Ships (${SHIPS_LIST.length})</b>\n`];
  for (const ship of SHIPS_LIST) {
    const zones         = (ship.zones || []).map(z => z.label || `${z.lat},${z.lon} r=${z.radiusKm}km`);
    lines.push(`🚢 ${ship.name || `MMSI ${ship.mmsi}`} — MMSI: <code>${ship.mmsi}</code>\n   Zones: ${zones.length ? zones.join(', ') : 'AIS-on alerts only'}`);
  }
  await sendTelegram(chatId, lines.join('\n'), 'HTML');
}

async function cmdListZones(chatId) {
  const keys            = Object.keys(zonesMod.ZONES);
  if (keys.length === 0) {
    return await sendTelegram(chatId, 'No named zones defined. You can add inline zones with /addzone.');
  }

  const lines           = [`📍 <b>Named Zones (${keys.length})</b>\n`];
  for (const key of keys) {
    const z             = zonesMod.ZONES[key];
    lines.push(`📌 <b>${z.label}</b> — ${z.lat}, ${z.lon} | r=${z.radiusKm} km`);
  }
  await sendTelegram(chatId, lines.join('\n'), 'HTML');
}

async function cmdAddShip(chatId, args) {
  if (!args) return await sendTelegram(chatId, 'Usage: /addship <mmsi> [name]');

  const parts           = args.trim().split(/\s+/);
  const mmsi            = parts[0];
  if (!/^\d{6,10}$/.test(mmsi)) {
    return await sendTelegram(chatId, `Invalid MMSI "${mmsi}". Must be 6–10 digits.`);
  }

  const SHIP_MAP        = shipsModule.SHIP_MAP;
  if (SHIP_MAP[mmsi]) {
    const existing      = SHIP_MAP[mmsi];
    return await sendTelegram(chatId, `MMSI ${mmsi} is already tracked as "${existing.name || mmsi}".`);
  }


  const name            = parts.slice(1).join(' ') || undefined;
  const ship            = { mmsi, zones: [] };
  if (name) ship.name    = name;

  const SHIPS_LIST      = shipsModule.SHIPS;
  SHIPS_LIST.push(ship);
  SHIP_MAP[mmsi]        = ship;

  await shipsModule.saveShips();
  await ai.reconnect();

  const label           = name || `MMSI ${mmsi}`;
  await sendTelegram(chatId,
       `✅ Added ${label}.\nUse /addzone "${label}" "<zone>" to add geo-fence zones.`);
  log(`Added ship: ${label} (${mmsi})`);
}

async function cmdRemoveShip(chatId, args) {
  if (!args) return await sendTelegram(chatId, 'Usage: /removeship <name or mmsi>');

  const ship          = shipsModule.findShip(args.trim());
  if (!ship)       return await sendTelegram(chatId, `No ship found matching "${args}". Use /listships to see all.`);

  shipsModule.takeShipsBackup();

  const mmsi            = String(ship.mmsi);
  const label           = ship.name || mmsi;

    // Remove from SHIPS array and SHIP_MAP
  const SHIPS_LIST      = shipsModule.SHIPS;
  for (let i = SHIPS_LIST.length - 1; i >= 0; i--) {
    if (String(SHIPS_LIST[i].mmsi) === mmsi) { SHIPS_LIST.splice(i, 1); break; }
  }
  delete shipsModule.SHIP_MAP[mmsi];

    // Clean up insideZone keys for this ship
  const toRemove        = [];
  for (const key of state.insideZone) {
    if (key.startsWith(`${mmsi}::`)) toRemove.push(key);
  }
  toRemove.forEach(k => state.clearInside(k));

  await shipsModule.saveShips();
  await ai.reconnect();

  await sendTelegram(chatId, `✅ Removed ${label} from tracking.`);
  log(`Removed ship: ${label} (${mmsi})`);
}

async function cmdSetName(chatId, args) {
  if (!args || !args.trim().includes(' ')) {
    return await sendTelegram(chatId, 'Usage: /setname <mmsi> <new name>');
  }

  const parts           = args.trim().split(/\s+/);
  const mmsi            = parts[0];
  const name            = parts.slice(1).join(' ');
  const SHIP_MAP        = shipsModule.SHIP_MAP;
  const ship            = SHIP_MAP[mmsi];

  if (!ship)         return await sendTelegram(chatId, `No ship found with MMSI ${mmsi}. Use /listships to see all.`);

  shipsModule.takeShipsBackup();

  const oldName       = ship.name || mmsi;
    // Check for name conflicts
  const conflict      = shipsModule.SHIPS.find(
     s => String(s.mmsi) !== mmsi && s.name && s.name.toLowerCase() === name.toLowerCase()
      );
  if (conflict) {
    return await sendTelegram(chatId,
         `⚠️ "${name}" is already the name of MMSI ${conflict.mmsi}. Choose a different name.`);
  }

  ship.name           = name;
  await shipsModule.saveShips();
  await sendTelegram(chatId, `✅ Renamed ${oldName} → ${name}`);
  log(`Renamed MMSI ${mmsi}: ${oldName} → ${name}`);
}

async function cmdSetCallsign(chatId, args) {
  if (!args || !args.trim().includes(' ')) {
    return await sendTelegram(chatId, 'Usage: /setcallsign <name or mmsi> <callsign>\nUse "none" to clear.');
  }

  const { ship, rest: callsignRaw } = splitShipArgs(args);
  if (!ship)         return await sendTelegram(chatId, `No ship found matching "${args}".`);
  if (!callsignRaw)  return await sendTelegram(chatId, 'Usage: /setcallsign <name or mmsi> <callsign>\nUse "none" to clear.');

  shipsModule.takeShipsBackup();

  const label           = ship.name || `MMSI ${ship.mmsi}`;
  const callsign        = callsignRaw.toUpperCase();

  if (callsign === 'NONE') {
    delete ship.callsign;
    await shipsModule.saveShips();
    return await sendTelegram(chatId, `✅ Cleared callsign for ${label}.`);
  } else {
    ship.callsign       = callsign;
    await shipsModule.saveShips();
    return await sendTelegram(chatId, `✅ Set callsign for ${label} → ${callsign}`);
  }
}

async function cmdAddAltName(chatId, args) {
  if (!args) return await sendTelegram(chatId, 'Usage: /addaltname <name or mmsi> <alternate name>');

  const { ship, rest: altNameRaw } = splitShipArgs(args);
  if (!ship)         return await sendTelegram(chatId, `No ship found matching "${args}".`);
  if (!altNameRaw)   return await sendTelegram(chatId, 'Provide both ship and alternate name.');

  shipsModule.takeShipsBackup();

  const altName         = altNameRaw.toUpperCase();
  if (!ship.altNames)    ship.altNames   = [];
  if (ship.altNames.map(n => n.toUpperCase()).includes(altName)) {
    return await sendTelegram(chatId, `"${altName}" is already in the alt names list for ${ship.name || ship.mmsi}.`);
  }

  ship.altNames.push(altName);
  await shipsModule.saveShips();

  const label           = ship.name || `MMSI ${ship.mmsi}`;
  return await sendTelegram(chatId, `✅ Added alt name "${altName}" to ${label}.`);
}

async function cmdRmAltName(chatId, args) {
  if (!args) return await sendTelegram(chatId, 'Usage: /rmaltname <name or mmsi> <alternate name>');

  const { ship, rest: altNameRaw } = splitShipArgs(args);
  if (!ship)         return await sendTelegram(chatId, `No ship found matching "${args}".`);
  if (!altNameRaw)   return await sendTelegram(chatId, 'Provide both ship and alternate name to remove.');

  shipsModule.takeShipsBackup();

  const altName         = altNameRaw.toUpperCase();
  const before          = (ship.altNames || []).length;
  ship.altNames         = (ship.altNames || []).filter(n => n.toUpperCase() !== altName);

  if (ship.altNames.length === before) {
    return await sendTelegram(chatId, `"${altName}" not found in alt names for ${ship.name || ship.mmsi}.`);
  }
  if (ship.altNames.length === 0) delete ship.altNames;

  await shipsModule.saveShips();
  const label           = ship.name || `MMSI ${ship.mmsi}`;
  return await sendTelegram(chatId, `✅ Removed alt name "${altName}" from ${label}.`);
}

async function cmdAddZone(chatId, args) {
  if (!args) {
    return await sendTelegram(chatId,
        'Usage:\n' +
        '   /addzone <ship> <zone name> [radiusKm]\n' +
        '   /addzone <ship> <lat,lon,radiusKm>');
  }

  const { ship, rest: zoneRaw } = splitShipArgs(args);
  if (!ship)         return await sendTelegram(chatId, `No ship found matching "${args}".`);
  if (!zoneRaw)      return await sendTelegram(chatId, 'Provide at least a ship and a zone. Use /help for syntax.');

  shipsModule.takeShipsBackup();

  const zoneTokens      = tokenize(zoneRaw);
  const zoneArg         = zoneTokens[0];
  const radiusArg       = zoneTokens[1] ? parseFloat(zoneTokens[1]) : null;
  let zone;

    // Try inline lat,lon,radius format
  const coordMatch      = zoneArg.match(/^(-?\d+\.?\d*),(-?\d+\.?\d*),(\d+\.?\d*)$/);
  if (coordMatch) {
    zone                = { label: zoneArg, lat: +coordMatch[1], lon: +coordMatch[2], radiusKm: +coordMatch[3] };
  } else {
       // Named zone from zones.json
    const named           = zonesMod.resolveZoneLabel(zoneArg);
    if (!named) {
      return await sendTelegram(chatId,
          `Zone "${zoneArg}" not found in named zones.\n` +
          `Use /listzones to see available zones, or provide lat,lon,radiusKm directly.`);
    }
    zone                = { ...named };
    if (radiusArg && !isNaN(radiusArg)) zone.radiusKm = radiusArg;
  }

    // Check if zone already exists on this ship
  const existing        = (ship.zones || []).findIndex(
     z => z.label.toLowerCase() === zone.label.toLowerCase());

  if (existing !== -1) {
    ship.zones[existing]    = zone;
    await shipsModule.saveShips();
    return await sendTelegram(chatId,
        `✅ Updated zone "${zone.label}" on ${ship.name || ship.mmsi} (r=${zone.radiusKm} km).`);
  } else {
    ship.zones.push(zone);
    await shipsModule.saveShips();
    return await sendTelegram(chatId,
        `✅ Added zone "${zone.label}" to ${ship.name || ship.mmsi} (r=${zone.radiusKm} km).`);
  }
}

async function cmdRmZone(chatId, args) {
  if (!args) return await sendTelegram(chatId, 'Usage: /rmzone <ship> <zone name>');

  const { ship, rest: zoneLabel } = splitShipArgs(args);
  if (!ship)         return await sendTelegram(chatId, `No ship found matching "${args}".`);
  if (!zoneLabel)    return await sendTelegram(chatId, 'Provide both ship and zone name. Use /help for syntax.');

  shipsModule.takeShipsBackup();
  const before          = (ship.zones || []).length;
  ship.zones            = (ship.zones || []).filter(
     z => z.label.toLowerCase() !== zoneLabel.toLowerCase());

  if (ship.zones.length === before) {
    return await sendTelegram(chatId,
        `Zone "${zoneLabel}" not found on ${ship.name || ship.mmsi}.\n` +
        `Use /listships to see current zones.`);
  }

  state.clearInside(`${ship.mmsi}::${zoneLabel}`);
  await shipsModule.saveShips();

  return await sendTelegram(chatId,
       `✅ Removed zone "${zoneLabel}" from ${ship.name || ship.mmsi}.`);
}

async function cmdListSuspect(chatId) {
  const LIST            = suspects.SUSPECTS;
  if (LIST.length === 0) {
    return await sendTelegram(chatId, '✅ No suspect MMSIs recorded.');
  }

  const header          = `🔍 <b>Suspect MMSIs (${LIST.length})</b>\n`;
  const footer          = '\nUse /clearsuspect &lt;mmsi&gt; to remove a false positive.';
  const LIMIT           = 3800; // leave headroom under Telegram's 4096-char cap

  let chunk             = header;
  let page              = 1;
  for (const s of LIST) {
    const when            = new Date(s.detectedAt).toUTCString();
    const entry           =
        `⚠️ <code>${s.suspectedMmsi}</code> → ${s.trackedName} (${s.trackedMmsi})\n` +
        `   Reason: ${s.reason}\n` +
        `   Detected: ${when}\n`;

    if (chunk.length + entry.length + footer.length > LIMIT) {
      await sendTelegram(chatId, chunk + footer, 'HTML');
      chunk               = `🔍 <b>Suspect MMSIs (cont. page ${++page})</b>\n`;
    }
    chunk += entry;
  }
  return await sendTelegram(chatId, chunk + footer, 'HTML');
}

async function cmdClearSuspect(chatId, args) {
  if (!args) return await sendTelegram(chatId, 'Usage: /clearsuspect <suspected mmsi>');

  const mmsi            = args.trim();
  const before          = suspects.SUSPECTS.length;
  suspects.SUSPECTS     = suspects.SUSPECTS.filter(s => s.suspectedMmsi !== mmsi);

  if (suspects.SUSPECTS.length === before) {
    return await sendTelegram(chatId, `MMSI ${mmsi} not found in suspect list.`);
  }

  await suspects.saveSuspects();
  return await sendTelegram(chatId, `✅ Removed MMSI ${mmsi} from suspect list. It will alert again if re-detected.`);
}

async function cmdUndo(chatId) {
  if (!lastShipsBackup) {
    return await sendTelegram(chatId, '❌ Nothing to undo or backup already restored.');
  }

  const SHIPS_LIST      = shipsModule.SHIPS;
  const SHIP_MAP        = shipsModule.SHIP_MAP;
  SHIPS_LIST.length     = 0;   // clear existing
  for (const s of lastShipsBackup) {
    SHIPS_LIST.push(s);
    SHIP_MAP[String(s.mmsi)]  = s;
  }

  lastShipsBackup       = null;
  await shipsModule.saveShips(true); // Save restored state, but don't backup the backup

  return await sendTelegram(chatId, '✅ Last change to ships has been undone.');
}

// ═══════════════════════════════════════════════════════════════════
// Telegram long-poll loop
// ═══════════════════════════════════════════════════════════════════

let BOT_USERNAME        = '';
const POLL_INTERVAL     = 5000;
const UPDATE_TIMEOUT    = 35000;

async function pollTelegram() {
  if (!config.TG_TOKEN) {
    log('TG_TOKEN not set — Telegram polling disabled');
    return;
  }

    // Fetch bot username for @mention stripping in groups
  try {
    const me            = await axios.get(`https://api.telegram.org/bot${config.TG_TOKEN}/getMe`, { timeout: 10000 });
    BOT_USERNAME        = (me.data.result.username || '').toLowerCase();
    log(`Telegram bot @${BOT_USERNAME} — polling for commands`);
  } catch (err) {
    log(`Failed to fetch bot info: ${err.message}`);
  }

  let offset            = 0;

  while (true) {
    try {
      const resp          = await axios.get(
           `https://api.telegram.org/bot${config.TG_TOKEN}/getUpdates`,
           { params: { offset, timeout: 30, allowed_updates: ['message'] }, timeout: UPDATE_TIMEOUT });

      const updates         = resp.data.result || [];
      for (const update of updates) {
        offset              = update.update_id + 1;
        handleTelegramUpdate(update).catch(err =>
            log(`Error handling update ${update.update_id}: ${err.message}`));
      }
    } catch (err) {
      if (err.code !== 'ECONNABORTED') {
        log(`Telegram poll error: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// HTTP status API
// ═══════════════════════════════════════════════════════════════════

require('http').createServer((req, res) => {
  if (req.url === '/status') {
    const out             = {};
    for (const ship of shipsModule.SHIPS) {
      const mmsi            = String(ship.mmsi);
      const pos             = state.getPos(mmsi);
      const isOnline        = pos && (Date.now() - new Date(pos.ts).getTime()) < config.STALE_MS;

      out[mmsi]             = {
        name:          ship.name || mmsi,
        lat:           pos ? pos.lat : null,
        lon:           pos ? pos.lon : null,
        ts:            pos ? pos.ts : null,
        insideZones:    (ship.zones || []).filter(z => z.label).map(z => z.label),
        hasBroadcast:     !!pos,
        isOnline:       isOnline,
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

// ═══════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════

if (!AISSTREAM_KEY || AISSTREAM_KEY === 'your_aisstream_api_key_here') {
  console.error('ERROR: Set AISSTREAM_KEY in your .env file first.');
  process.exit(1);
}

zonesMod.loadZones();
shipsModule.loadShips(() => log('Ship list changed — reconnecting...'));
state.loadState();
suspects.loadSuspects();

const enhancedTracking        = shipsModule.SHIPS.some(s => !!(s.callsign || (s.altNames && s.altNames.length > 0)));
ai.start({ onMessage: handleAisMessage, enhancedTracking });
pollTelegram();

// File watchers — hot-reload without restart
let reloadShipsTimer          = null;
fs.watch(SHIPS_FILE, () => {
  clearTimeout(reloadShipsTimer);
  reloadShipsTimer            = setTimeout(() => {
    log('ships.json changed — reloading...');
    shipsModule.loadShips();
  }, 500);
});

let reloadZonesTimer          = null;
fs.watch(ZONES_FILE, () => {
  clearTimeout(reloadZonesTimer);
  reloadZonesTimer            = setTimeout(() => {
    log('zones.json changed — reloading...');
    zonesMod.loadZones();
  }, 500);
});

// SIGHUP — reload .env without restart
process.on('SIGHUP', () => {
  require('dotenv').config({ override: true });
  log(`[config] Reloaded .env — LLAMA_MODEL is now "${config.LLAMA_MODEL}"`);
});
