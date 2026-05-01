const fs = require('fs');
const path = require('path');

let ZONES = {}; // label → { label, lat, lon, radiusKm }

function loadZones() {
  try {
    ZONES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zones.json'), 'utf8'));
  } catch {
    ZONES = {};
  }
}

function resolveZoneLabel(label) {
  const lower = label.toLowerCase();
  const key = Object.keys(ZONES).find(k => k.toLowerCase() === lower);
  return key ? ZONES[key] : null;
}

module.exports = { get ZONES() { return ZONES; }, loadZones, resolveZoneLabel };
