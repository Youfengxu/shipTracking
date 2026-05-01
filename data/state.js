const fs       = require('fs');
const path     = require('path');

const insideZone   = new Set();    // "mmsi::zoneLabel"
const lastPosition = new Map();    // mmsi → { lat, lon, ts }
let saveStateCb    = null;          // set from entry point after wiring

function loadState() {
  const stateFile = path.join(__dirname, '..', 'state.json');
  try {
    if (fs.existsSync(stateFile)) {
      const data     = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (data.lastPosition) {
        for (const [mmsi, pos] of Object.entries(data.lastPosition)) {
          lastPosition.set(mmsi, pos);
        }
        }
      if (data.insideZone && Array.isArray(data.insideZone)) {
        for (const key of data.insideZone) insideZone.add(key);
       }
      }
    } catch {
     // swallow
   }
}

function saveStateThrottled() {
  if (!saveStateCb) return;
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveStateCb, 5000);
}

let saveStateTimer = null;

// ── Convenience helpers (operate on internal state) ───────────────────

function setInside(key)        { insideZone.add(key); }
function clearInside(key)      { insideZone.delete(key); }
const hasInside               = insideZone.has.bind(insideZone);
function getPos(mmsi)          { return lastPosition.get(mmsi); }
function setPos(mmsi, pos)     { lastPosition.set(mmsi, pos); saveStateThrottled(); }

// ── Callback wiring (called from entry point) ───────────────────────

function setSaveState(cb)     { saveStateCb = cb; }
function setStateFile()       { return path.join(__dirname, '..', 'state.json'); }

module.exports = {
  get insideZone()    { return insideZone; },
  get lastPosition()  { return lastPosition; },
  loadState,
  setSaveState,
  setStateFile,
  saveStateThrottled,
  setInside,
  clearInside,
  hasInside,
  getPos,
  setPos,
};
