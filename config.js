const path       = require('path');

const AISSTREAM_KEY      = process.env.AISSTREAM_KEY;
const TG_TOKEN           = process.env.TG_TOKEN;
const TG_CHAT_ID         = process.env.TG_CHAT_ID;
const SHIPS_FILE         = path.join(__dirname, 'ships.json');
const ZONES_FILE         = path.join(__dirname, 'zones.json');
const STATE_FILE         = path.join(__dirname, 'state.json');
const SUSPECTS_FILE      = path.join(__dirname, 'suspects.json');

const LLAMA_URL          = process.env.LLAMA_URL   || 'http://192.168.100.140:8081';
const LLAMA_MODEL        = process.env.LLAMA_MODEL || 'Qwen3-8B-Q4_K_M.gguf';

// ── Constants ───────────────────────────────────────────────────────

const AIS_CHECK_WINDOW    = 30 * 60 * 1000; // 30 min
const STARTUP_GRACE_MS    = 5 * 60 * 1000;   // suppress restart noise for 5 min
const STALE_MS            = 30 * 60 * 1000; // 30 min without signal = considered off

// ── Runtime boot constants ──────────────────────────────────────────

const startupTime         = Date.now();

const NAVAL_PREFIXES     = new Set([
     'USS','HMS','HMAS','HMNZS','KRI','KD','JS','MV','MT','SV',
     'HDMS','FGS','FS','HNLMS','HTMS','KDB','RSS','INS','BRP','RFA',
]);

module.exports = {
  AISSTREAM_KEY, TG_TOKEN, TG_CHAT_ID,
  SHIPS_FILE, ZONES_FILE, STATE_FILE, SUSPECTS_FILE,
  LLAMA_URL, LLAMA_MODEL,
  AIS_CHECK_WINDOW, STARTUP_GRACE_MS, STALE_MS,
  NAVAL_PREFIXES, startupTime,
};
