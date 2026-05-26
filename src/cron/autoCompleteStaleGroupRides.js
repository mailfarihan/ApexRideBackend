const Trip = require('../models/Trip');

/**
 * Auto-complete ongoing group rides that have been left open too long.
 *
 * Some creators forget to tap "End ride" — leaving the trip in `ongoing` for
 * many hours. New rides started later by other attendees can then mis-link to
 * this stale trip. Sweeping these closed prevents that and cleans up state.
 *
 * Rule: any trip in status='ongoing' whose actualStartTime (or dateTime as
 * fallback) is older than STALE_GROUP_RIDE_MS is set to status='completed'.
 */
const STALE_GROUP_RIDE_MS = 12 * 60 * 60 * 1000; // 12 hours

async function autoCompleteStaleGroupRides() {
  try {
    const now = Date.now();
    const cutoff = now - STALE_GROUP_RIDE_MS;
    const stale = await Trip.find({
      status: 'ongoing',
      $or: [
        { actualStartTime: { $ne: null, $lte: cutoff } },
        { actualStartTime: { $eq: null }, dateTime: { $lte: cutoff } }
      ]
    }).select('_id actualStartTime dateTime title').lean();

    if (stale.length === 0) {
      return;
    }

    console.log(`[StaleGroupRide] Auto-completing ${stale.length} stale group ride(s)...`);
    for (const trip of stale) {
      try {
        await Trip.findByIdAndUpdate(trip._id, {
          $set: {
            status: 'completed',
            actualEndTime: now
          }
        });
      } catch (err) {
        console.error(`[StaleGroupRide] Failed to complete ${trip._id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[StaleGroupRide] Sweep failed:', err.message);
  }
}

module.exports = autoCompleteStaleGroupRides;
