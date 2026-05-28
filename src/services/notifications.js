// Push notification helpers (Firebase Cloud Messaging).
// Server-only: caller passes recipient uids + payload; we look up tokens
// and prune any that come back unregistered/invalid.

const admin = require('firebase-admin');
const User = require('../models/User');

async function collectTokens(uids) {
  if (!Array.isArray(uids) || uids.length === 0) return new Map();
  const docs = await User.find(
    { firebaseUid: { $in: uids }, fcmTokens: { $exists: true, $ne: [] } },
    { firebaseUid: 1, fcmTokens: 1 }
  ).lean();
  const map = new Map();
  for (const d of docs) {
    if (Array.isArray(d.fcmTokens) && d.fcmTokens.length) {
      map.set(d.firebaseUid, d.fcmTokens);
    }
  }
  return map;
}

async function pruneInvalidTokens(uid, tokens, invalidIdx) {
  if (!invalidIdx.length) return;
  const bad = invalidIdx.map((i) => tokens[i]).filter(Boolean);
  if (!bad.length) return;
  try {
    await User.updateOne(
      { firebaseUid: uid },
      { $pull: { fcmTokens: { $in: bad } } }
    );
  } catch (e) {
    console.warn('Failed to prune FCM tokens for', uid, e.message);
  }
}

// data: { title, body, subtext?, largeIconUrl?, deepLink?, extras? }
async function sendRideCompletedNotification(recipientUids, data) {
  if (!recipientUids || !recipientUids.length) return { sent: 0 };
  let messaging;
  try {
    messaging = admin.messaging();
  } catch (e) {
    console.warn('FCM not initialised, skipping notify:', e.message);
    return { sent: 0 };
  }

  const tokenMap = await collectTokens(recipientUids);
  let sent = 0;
  for (const [uid, tokens] of tokenMap.entries()) {
    if (!tokens.length) continue;
    try {
      const resp = await messaging.sendEachForMulticast({
        tokens,
        data: {
          type: 'ride_completed',
          title: String(data.title || ''),
          body: String(data.body || ''),
          subtext: String(data.subtext || ''),
          largeIconUrl: String(data.largeIconUrl || ''),
          deepLink: String(data.deepLink || ''),
          ...(data.extras || {})
        },
        android: {
          priority: 'high',
          ttl: 3600 * 1000
        }
      });
      sent += resp.successCount;
      // Collect invalid token indices and prune
      const invalidIdx = [];
      resp.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error?.code || '';
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument'
          ) {
            invalidIdx.push(i);
          }
        }
      });
      await pruneInvalidTokens(uid, tokens, invalidIdx);
    } catch (e) {
      console.warn('sendEachForMulticast failed for', uid, e.message);
    }
  }
  return { sent };
}

module.exports = { sendRideCompletedNotification };
