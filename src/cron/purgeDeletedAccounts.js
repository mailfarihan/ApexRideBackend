const User = require('../models/User');
const Ride = require('../models/Ride');
const Trip = require('../models/Trip');
const Route = require('../models/Route');
const Telemetry = require('../models/Telemetry');
const admin = require('firebase-admin');
const { deleteFromFirebase } = require('../services/mapImage');

/**
 * Permanently delete accounts that have passed their 30-day grace period.
 * Should be called once daily (e.g., via setInterval or external cron).
 */
async function purgeDeletedAccounts() {
  try {
    const now = new Date();
    const usersToDelete = await User.find({
      deletionScheduledAt: { $ne: null, $lte: now }
    });

    if (usersToDelete.length === 0) {
      console.log('[Purge] No accounts to purge');
      return;
    }

    console.log(`[Purge] Purging ${usersToDelete.length} account(s)...`);

    for (const user of usersToDelete) {
      const uid = user.firebaseUid;
      try {
        // 1. Delete profile photo from Firebase Storage
        if (user.photoUrl) {
          deleteFromFirebase(user.photoUrl).catch(() => {});
        }

        // 2. Delete ride map images from Firebase Storage
        const rides = await Ride.find({ userId: uid }, { mapImageLightUrl: 1, mapImageDarkUrl: 1 });
        for (const ride of rides) {
          if (ride.mapImageLightUrl) deleteFromFirebase(ride.mapImageLightUrl).catch(() => {});
          if (ride.mapImageDarkUrl) deleteFromFirebase(ride.mapImageDarkUrl).catch(() => {});
        }

        // 3. Delete route map images from Firebase Storage
        const routes = await Route.find({ creatorId: uid }, { mapImageLightUrl: 1, mapImageDarkUrl: 1 });
        for (const route of routes) {
          if (route.mapImageLightUrl) deleteFromFirebase(route.mapImageLightUrl).catch(() => {});
          if (route.mapImageDarkUrl) deleteFromFirebase(route.mapImageDarkUrl).catch(() => {});
        }

        // 4. Cascade delete all user data from MongoDB
        await Promise.all([
          Ride.deleteMany({ userId: uid }),
          Telemetry.deleteMany({ userId: uid }),
          Route.deleteMany({ creatorId: uid }),
          Trip.updateMany({ attendeeIds: uid }, { $pull: { attendeeIds: uid } }),
          Trip.deleteMany({ creatorId: uid }),
          User.updateMany({ followers: uid }, { $pull: { followers: uid } }),
          User.updateMany({ following: uid }, { $pull: { following: uid } }),
          User.deleteOne({ firebaseUid: uid })
        ]);

        // 5. Delete Firebase Auth account
        try {
          await admin.auth().deleteUser(uid);
        } catch (authErr) {
          console.warn(`[Purge] Firebase Auth deletion warning for ${uid}:`, authErr.message);
        }

        console.log(`[Purge] Permanently deleted account: ${uid}`);
      } catch (err) {
        console.error(`[Purge] Failed to purge account ${uid}:`, err);
      }
    }

    console.log(`[Purge] Completed purging ${usersToDelete.length} account(s)`);
  } catch (error) {
    console.error('[Purge] Error running purge job:', error);
  }
}

module.exports = purgeDeletedAccounts;
