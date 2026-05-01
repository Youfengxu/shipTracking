const axios = require('axios');

async function sendPushover(text) {
  const token = process.env.PUSHOVER_TOKEN;
  const user   = process.env.PUSHOVER_USER;
  if (!token || !user) return;
  try {
    await axios.post('https://api.pushover.net/1/messages.json', {
      token,
      user,
      title: '🚢 Ship Alert',
      message: text,
     });
   } catch {
    // log handled by caller
   }
}

module.exports = { sendPushover };
