const log              = console.log;
const { STALE_MS, STARTUP_GRACE_MS, startupTime }  = require('../config');
const SHIPS            = require('../data/ships');
const state            = require('../data/state');
const suspects         = require('../data/suspects');
const geo              = require('../geo');
const notify           = require('../notifications').notify;
const { sendTelegram } = require('../notifications');

// ── Helpers ────────────────────────────────────────────────────────────

const _NAVAL_PREFIXES = new Set([
    'USS','HMS','HMAS','HMNZS','KRI','KD','JS','MV','MT','SV',
    'HDMS','FGS','FS','HNLMS','HTMS','KDB','RSS','INS','BRP','RFA',
]);

function _nameFmt(raw) {
  return raw.split(/\s+/).map(word => {
    const upper = word.toUpperCase();
    return _NAVAL_PREFIXES.has(upper) ? upper : upper.charAt(0) + word.slice(1).toLowerCase();
   }).join(' ');
}

/** True when a ship has enhanced detection (callsign or altNames set). */
function _hasEnhanced(s) {
  return !!(s.callsign || (s.altNames && s.altNames.length > 0));
}

/** Send an "AIS turned on" alert to all channels. */
async function notifyAisOn(ship, pos) {
  const label      = ship.name || `MMSI ${ship.mmsi}`;
  const location   = await geo.reverseGeocode(pos.lat, pos.lon);
  const locLine    = location ? `\n📍 ${location}` : '';
  const plain      = `📡 AIS TURNED ON\n🚢 ${label} (MMSI ${ship.mmsi})\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html       = `📡 AIS TURNED ON\n🚢 ${label} (MMSI ${ship.mmsi})\n🌐 ${geo.coordHtml(pos.lat, pos.lon)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'ais_on', mmsi: ship.mmsi, shipName: label, lat: pos.lat, lon: pos.lon }, html);
}

/** Send a "zone entry" alert to all channels. */
async function notifyEntry(ship, zone, pos) {
  const label      = ship.name || `MMSI ${ship.mmsi}`;
  const location   = await geo.reverseGeocode(pos.lat, pos.lon);
  const locLine    = location ? `\n📍 ${location}` : '';
  const plain      = `🟢 ZONE ENTRY\n🚢 ${label}\n📍 Entered: ${zone.label}\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)} — ${pos.distKm.toFixed(2)} km from centre${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html       = `🟢 ZONE ENTRY\n🚢 ${label}\n📍 Entered: ${zone.label}\n🌐 ${geo.coordHtml(pos.lat, pos.lon)} — ${pos.distKm.toFixed(2)} km from centre${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'zone_entry', mmsi: ship.mmsi, shipName: label, zone: zone.label, lat: pos.lat, lon: pos.lon, distKm: pos.distKm }, html);
}

/** Send a "zone exit / possible departure" alert to all channels. */
async function notifyExit(ship, zone, pos) {
  const label      = ship.name || `MMSI ${ship.mmsi}`;
  const location   = await geo.reverseGeocode(pos.lat, pos.lon);
  const locLine    = location ? `\n📍 ${location}` : '';
  const plain      = `🔴 ZONE EXIT / POSSIBLE DEPARTURE\n🚢 ${label}\n📍 Left: ${zone.label}\n🌐 ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html       = `🔴 ZONE EXIT / POSSIBLE DEPARTURE\n🚢 ${label}\n📍 Left: ${zone.label}\n🌐 ${geo.coordHtml(pos.lat, pos.lon)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'zone_exit', mmsi: ship.mmsi, shipName: label, zone: zone.label, lat: pos.lat, lon: pos.lon }, html);
}

/** Send a "possible MMSI change" alert to all channels. */
async function notifyPossibleMmsiChange(ship, newMmsi, reason, lat, lon) {
    // Already recorded — silently ignore, no repeat alert
  if (suspects.isSuspectKnown(ship.mmsi, newMmsi)) return;

    // In-memory cooldown guards against duplicate fires before suspects.json is written
  const key = `${ship.mmsi}::${newMmsi}`;
  const now = Date.now();
  if (_mmsiChangeAlerts.has(key) && now - _mmsiChangeAlerts.get(key) < 3_600_000) return;
    _mmsiChangeAlerts.set(key, now);

    // Persist to suspects list before alerting
  suspects.addSuspect(ship, newMmsi, reason, lat, lon);

  const label      = ship.name || `MMSI ${ship.mmsi}`;
  const location   = await geo.reverseGeocode(lat, lon);
  const locLine    = location ? `\n📍 ${location}` : '';
  const plain      = `⚠️ POSSIBLE MMSI CHANGE\n🚢 ${label} (tracked MMSI ${ship.mmsi})\n📡 Spotted MMSI: ${newMmsi} (${reason})\n🌐 ${lat.toFixed(4)}, ${lon.toFixed(4)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  const html       = `⚠️ POSSIBLE MMSI CHANGE\n🚢 ${label} (tracked MMSI ${ship.mmsi})\n📡 Spotted MMSI: ${newMmsi} (${reason})\n🌐 ${geo.coordHtml(lat, lon)}${locLine}\n🕐 ${new Date().toUTCString()}`;
  await notify(plain, { event: 'possible_mmsi_change', trackedMmsi: ship.mmsi, newMmsi, shipName: label, reason, lat, lon }, html);
}

/** Schedule an AIS-off follow-up timer for a MMSI. */
function scheduleAisCheck(mmsi) {
  const targetId = mmsi; // default: no chat override (caller should adapt)
  if (!targetId) return;

  clearPendingAisCheck(mmsi);
  const timer = setTimeout(async () => {
       _pendingAisChecks.delete(mmsi);
    const ship = SHIPS.SHIPS.find(s => String(s.mmsi) === mmsi);
    if (!ship) return;
    const label = ship.name || `MMSI ${mmsi}`;
    const mins   = Math.round(require('../config').AIS_CHECK_WINDOW / 60000);
    await sendTelegram(null,
        `⚠️ NO AIS SIGNAL DETECTED\n` +
        `🚢 ${label} (MMSI ${mmsi})\n` +
        `📵 No position report received in the last ${mins} minutes.\n` +
        `   AIS may be off or out of terrestrial coverage.\n` +
        `   You will be alerted automatically when it comes online.`
      );
    log(`AIS check timeout for ${label}`);
  }, require('../config').AIS_CHECK_WINDOW);
    _pendingAisChecks.set(mmsi, { timer });
}

/** Cancel a pending AIS-off follow-up timer. */
function clearPendingAisCheck(mmsi) {
  const entry = _pendingAisChecks.get(mmsi);
  if (entry) {
    clearTimeout(entry.timer);
      _pendingAisChecks.delete(mmsi);
   }
}

// ── In-memory state shared across this module ────────────────────────

const _mmsiChangeAlerts = new Map(); // "trackedMmsi::newMmsi" → last alert ms (1hr cooldown)
const _pendingAisChecks = new Map(); // mmsi → { timer }

/** Main AIS event handler — dispatches every incoming WS message. */
async function handleAisMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const meta = msg.MetaData;
  if (!meta) return;

  const mmsi = String(meta.MMSI);
  const lat    = meta.latitude;
  const lon    = meta.longitude;
  const now    = Date.now();

    // ── ShipStaticData: auto-populate name/callsign for tracked ships ──
  if (msg.MessageType === 'ShipStaticData') {
    const sd           = msg.Message?.ShipStaticData;
    const rxName       = (sd?.Name || meta.ShipName || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const rxCallsign   = (sd?.CallSign || '').trim().toUpperCase();

    if (rxName || rxCallsign) {
        // Auto-populate for tracked ships missing name/callsign
      const ship = SHIPS.SHIPS.find(s => String(s.mmsi) === mmsi);
      if (ship) {
        let updated = false;
        if (rxName && !ship.name) {
          ship.name = _nameFmt(rxName);
          updated = true;
         }
        if (rxCallsign && !ship.callsign) {
          ship.callsign = rxCallsign;
          updated = true;
         }
        if (updated) {
          SHIPS.saveShips();
          const label = ship.name || `MMSI ${mmsi}`;
          log(`Auto-populated ${label} (MMSI ${mmsi}) — name=${ship.name || '–'} callsign=${ship.callsign || '–'}`);
          const lines = [`📋 Ship details auto-populated`, `🚢 MMSI ${mmsi}`];
          if (ship.name)     lines.push(`   Name: ${ship.name}`);
          if (ship.callsign) lines.push(`   Callsign: ${ship.callsign}`);
          await sendTelegram(null, lines.join('\n'));
         }
       }

        // Enhanced tracking: MMSI-change detection via ShipStaticData
      const SHIPS_LIST = SHIPS.SHIPS;
      for (const trackedShip of SHIPS_LIST) {
        if (String(trackedShip.mmsi) === mmsi) continue; // same MMSI — no alert
        if (!_hasEnhanced(trackedShip)) continue;

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
    return; // nothing else to do with ShipStaticData
  }

    // ── PositionReport ──
  const ship = SHIPS.SHIPS.find(s => String(s.mmsi) === mmsi);
  if (ship) {
      // Update position and check AIS-on status
    const prev           = state.getPos(mmsi);
    const lastSeen       = prev ? new Date(prev.ts).getTime() : 0;
    const wasOff         = !prev || (now - lastSeen) > STALE_MS;

    state.setPos(mmsi, { lat, lon, ts: new Date().toISOString() });

    if (wasOff) {
      clearPendingAisCheck(mmsi);
        // Suppress alert if we saw it very recently (e.g. restart grace)
        // or if we just started up and it was already in state.json
      const recentlySeen = (now - lastSeen) < (5 * 60 * 1000);
      if (!recentlySeen && (now > startupTime + STARTUP_GRACE_MS)) {
        await notifyAisOn(ship, { lat, lon });
       }
     }

      // Reset the "gone dark" timer
    scheduleAisCheck(mmsi);

      // ── Zone Entry/Exit checks ──
    const zones = ship.zones || [];
    for (const zone of zones) {
      const distKm     = geo.haversineKm(zone.lat, zone.lon, lat, lon);
      const inZone     = distKm <= zone.radiusKm;
      const stateKey   = `${mmsi}::${zone.label}`;

      if (inZone && !state.hasInside(stateKey)) {
        state.setInside(stateKey);
        await notifyEntry(ship, zone, { lat, lon, distKm });
       } else if (!inZone && state.hasInside(stateKey)) {
        state.clearInside(stateKey);
        await notifyExit(ship, zone, { lat, lon, distKm });
       }
     }
   }
}

module.exports = { handleAisMessage, notifyAisOn, notifyEntry, notifyExit, notifyPossibleMmsiChange, scheduleAisCheck, clearPendingAisCheck };
