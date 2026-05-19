const WebSocket = require('ws');
const log          = console.log;

let ws              = null;
let reconnectDelay  = 5000;

/** @param {string[]} filters - FilterMessageTypes array. */
function subscribe(typeFilters) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  log('Connected. Sending subscription...');

  const bb           = require('../data/ships')._getBoundingBoxes;
  const key          = require('../config').AISSTREAM_KEY;
  ws.send(JSON.stringify({
    APIKey:             key,
    BoundingBoxes:      bb(),
    FilterMessageTypes: typeFilters,
   }));
}

function start(shipsConfig) {
  const SHIPS        = require('../data/ships');

  log(`Connecting to aisstream.io — tracking ${SHIPS.SHIPS.length} ship(s)`);
  for (const s of SHIPS.SHIPS) {
    const zones = s.zones || [];
    if (zones.length > 0)
      zones.forEach(z => log(`    ${s.name || s.mmsi} (${s.mmsi}) -> "${z.label}" r=${z.radiusKm} km`));
    else
      log(`    ${s.name || s.mmsi} (${s.mmsi}) -> AIS-on only`);
   }

  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    reconnectDelay = 5000;
    const typeFilters = shipsConfig.enhancedTracking
       ? ['PositionReport', 'ShipStaticData']
       : ['PositionReport'];
    subscribe(typeFilters);
   });

  if (shipsConfig.onMessage) ws.on('message', shipsConfig.onMessage);

  ws.on('close', (code, _reason) => {
    log(`Disconnected (${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    clearInterval(ws._pingInterval);
    setTimeout(() => start(shipsConfig), reconnectDelay);
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

function reconnect() {
  log('Ship list changed — reconnecting WebSocket with updated subscription...');
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
   }
}

module.exports = { start, subscribe, reconnect };
