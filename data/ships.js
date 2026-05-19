const fs = require('fs');
const path = require('path');

let SHIPS = [];
let SHIP_MAP = {};

/** Call to revert SHIPS to a previous snapshot. Returns old snapshot. */
function takeShipsBackup() {
  return JSON.parse(JSON.stringify(SHIPS));
}

function loadShips(onUpdate) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ships.json'), 'utf8'));
    SHIPS = raw.map(s => {
      if (s.zone && !s.zones) {
        const { zone, ...rest } = s;
        return { ...rest, zones: [zone] };
      }
      return { zones: [], ...s };
    });
    SHIP_MAP = {};
    for (const s of SHIPS) SHIP_MAP[String(s.mmsi)] = s;
    if (onUpdate) onUpdate();
  } catch {
    SHIPS     = [];
    SHIP_MAP  = {};
  }
}

function saveShips(skipBackup) {
  fs.writeFileSync(path.join(__dirname, '..', 'ships.json'), JSON.stringify(SHIPS, null, 2));
  if (!skipBackup) require('./state').saveStateThrottled();
}

/** Synchronous query — use only from synchronous callers. Prefer async findShip. */
function findShip(query) {
  const q = String(query).trim();
  if (SHIP_MAP[q]) return SHIP_MAP[q];
  const lower = q.toLowerCase();
  return SHIPS.find(s => s.name && s.name.toLowerCase().includes(lower)) || null;
}

/** Build bounding boxes for AIS subscription. Internal use. */
function _getBoundingBoxes() {
  const boxes     = [];
  for (const s of SHIPS) {
    for (const z of (s.zones || [])) {
      boxes.push([[z.lat - 1, z.lon - 1], [z.lat + 1, z.lon + 1]]);
       }
    }
  return boxes.length > 0 ? boxes : [[[-90, -180], [90, 180]]];
}

module.exports = {
  get SHIPS() { return SHIPS; },
  get SHIP_MAP() { return SHIP_MAP; },
  takeShipsBackup,
  loadShips,
  saveShips,
  findShip,
  _getBoundingBoxes,
};
