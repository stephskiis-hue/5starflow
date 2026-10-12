// One place for the dedupKey of a "customer is waiting" task, so every writer (sms-monitor, AI reply, the Ollama
// worker, the TextNow watcher) lands on the same row for the same conversation.
const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// channel 'sms' (Twilio) keeps the original `sms:<last10>`; other channels get their own prefix.
const convTaskKey = (channel, phone) => `${channel === 'sms' ? 'sms' : channel}:${last10(phone)}`;
const isLegacySmsKey = (key) => /^sms:\D*\d{11,}$/.test(String(key || '')) && String(key).slice(4) !== last10(key);

module.exports = { last10, convTaskKey, isLegacySmsKey };
