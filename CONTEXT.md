# Ship Tracker — Project Context

## Stack
- Node.js running on a Mac Mini, managed by pm2
- AIS data via aisstream.io WebSocket
- Alerts via Telegram (primary) and Pushover

## Current behaviour
Tracks vessels by MMSI. Fires an alert when a tracked MMSI is spotted inside a configured geo-fence zone. Supports multiple ships and multiple zones per ship.

## Target vessels (example use case)
- **USS Tulsa** — callsign NFGP, US Navy (MMSI prefix 338xxxxxx)
- **USS Santa Barbara** — callsign NVCK, US Navy (MMSI prefix 338xxxxxx)
- Both vessels operate in/around Singapore Straits and may swap their MMSI codes while in port.

## Anchorage reference
Sembcorp Marine / Tuas Basin area: approximately 1.27°N, 103.75°E

## Enhanced MMSI-change detection (implemented, per-ship opt-in)

Enhanced tracking is enabled for a ship when it has a `callsign` and/or `altNames` set. It works for **any tracked ship**, not just military vessels.

### How to enable
```
/setcallsign <name_or_mmsi> <callsign>    — set AIS callsign (e.g. NFGP)
/setcallsign <name_or_mmsi> clear         — remove callsign
/addaltname  <name_or_mmsi> <altName>     — add an alternative broadcast name
```

### Detection layer 1 — Name & callsign matching (ShipStaticData)
When any ship has enhanced tracking active, the aisstream.io subscription switches from MMSI-filtered to all-vessels-in-bounding-box and adds `ShipStaticData` messages. When a `ShipStaticData` message arrives from an unknown MMSI whose broadcast name or callsign matches a tracked ship, an alert is fired.

### Detection layer 2 — MMSI prefix proximity (PositionReport)
If an unknown MMSI whose first 3 digits match a tracked ship's MMSI appears inside that ship's zone, an alert is fired. This catches a silent MMSI swap where the vessel broadcasts no name/callsign.

### Alert format
```
⚠️ POSSIBLE MMSI CHANGE
🚢 <Ship Name> (tracked MMSI <old>)
📡 Spotted MMSI: <new> (<match reason>)
🌐 <lat>, <lon>
🕐 <timestamp>
```
Alerts have a 1-hour per-pair cooldown to prevent spam.

### Ship data model (extended)
```json
{
  "mmsi": "338123456",
  "name": "USS Tulsa",
  "callsign": "NFGP",
  "altNames": ["TULSA"],
  "zones": [...]
}
```
