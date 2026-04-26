const axios = require('axios');

const { TG_TOKEN, TG_CHAT_ID }         = require('../config');

async function sendTelegram(chatId, text, parseMode) {
  if (!TG_TOKEN) return;
  const target = chatId || TG_CHAT_ID;
  if (!target) return;
  try {
    const body = { chat_id: target, text };
    if (parseMode) body.parse_mode = parseMode;
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, body);
  } catch (err) {
    console.error('[sendTelegram] error:', err?.response?.data || err.message);
  }
}

async function sendWebhook(payload) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;
  try {
    await axios.post(url, { ...payload, timestamp: new Date().toISOString() });
  } catch (_err) {
     // logged by caller
   }
}

/** Aggregate notify — fire all channels. */
async function notify(text, payload, tgHtml) {
  const { sendPushover } = require('./pushover');
  await Promise.allSettled([
    sendTelegram(null, tgHtml || text, tgHtml ? 'HTML' : undefined),
    sendPushover(text),
    sendWebhook(payload),
  ]);
}

module.exports = { notify, sendTelegram };
