const axios = require('axios');

const R = 6371; // Earth radius in km

/** Haversine distance in km. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Reverse geocode a lat/lon via Nominatim. Returns string or null. */
async function reverseGeocode(lat, lon) {
  try {
    const resp = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon, format: 'json' },
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

module.exports = { haversineKm, reverseGeocode, mapsUrl, coordHtml };
