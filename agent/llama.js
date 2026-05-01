const axios = require('axios');

/** Translate a natural-language query into an array of { command, args } objects. */
async function translateIntent(nlQuery) {
  const LLAMA_URL     = process.env.LLAMA_URL;
  const LLAMA_MODEL   = process.env.LLAMA_MODEL || 'llama-model';
  if (!LLAMA_URL) return null;

  const ships     = require('../data/ships');
  const zones     = require('../data/zones');
  const shipCtx   = ships.SHIPS.map(s => `${s.name || 'Unnamed'}: ${s.mmsi}`).join(', ');
  const zoneNames = Object.keys(zones.ZONES).join(', ');

  const systemPrompt = `You are the Command Orchestrator for an AIS Ship Tracker.
Translate user requests into system commands.

CURRENT ASSETS (Name: MMSI):
${shipCtx || 'None'}

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
Response: [{"command": "/removeship", "args": "368926114"}]`;

  try {
    const response = await axios.post(`${LLAMA_URL}/v1/chat/completions`, {
      model: LLAMA_MODEL,
      messages: [
         { role: 'system', content: systemPrompt },
         { role: 'user',   content: `User query: "${nlQuery}"` },
       ],
      stream: false,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
     }, { timeout: 90000 });

    const raw = response.data.choices?.[0]?.message?.content ?? '';
    let result;
    try {
      result = JSON.parse(raw || '[]');
    } catch (e) {
      return { error: `Parse error: ${e.message}` };
     }

     // Normalize single object to array
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      result = [result];
    }

    if (Array.isArray(result) && result.length > 0) {
      const valid = result.filter(item => item && item.command && item.command !== 'UNKNOWN');
      if (valid.length > 0) return valid;
    }
    return { error: 'No valid commands found in response.' };
  } catch (err) {
    if (err.response?.status === 404) {
      return { error: `Model "${LLAMA_MODEL}" not found.` };
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    return { error: `Llama error: ${detail}` };
   }
}

module.exports = { translateIntent };
