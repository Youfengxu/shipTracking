const fs       = require('fs');
const path     = require('path');

let SUSPECTS       = [];  // array, ordered oldest-first

function loadSuspects() {
  try {
    SUSPECTS      = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'suspects.json'), 'utf8'));
    } catch {
    SUSPECTS      = [];
    }
}

function saveSuspects() {
  fs.writeFileSync(path.join(__dirname, '..', 'suspects.json'), JSON.stringify(SUSPECTS, null, 2));
}

function isSuspectKnown(trackedMmsi, suspectedMmsi) {
  return SUSPECTS.some(s => String(s.suspectedMmsi) === String(suspectedMmsi));
}

function addSuspect(trackedShip, suspectedMmsi, reason, lat, lon) {
  SUSPECTS.push({
    suspectedMmsi: String(suspectedMmsi),
    trackedMmsi:   String(trackedShip.mmsi),
    trackedName:   trackedShip.name || `MMSI ${trackedShip.mmsi}`,
    reason,
    lat,
    lon,
    detectedAt: new Date().toISOString(),
     });
  saveSuspects();
}

module.exports = {
  get SUSPECTS()       { return SUSPECTS; },
  loadSuspects,
  saveSuspects,
  isSuspectKnown,
  addSuspect,
};
