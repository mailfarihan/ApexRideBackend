const mongoose = require('mongoose');

/**
 * Telemetry collection — stored separately from Ride for lazy loading.
 * Parallel arrays: speed[i], gForce[i], leanAngle[i], timestamp[i], cumDistanceM[i]
 * all describe the same sample point.
 *
 * Indexed by (userId, rideId) so a group-ride comparison query can fetch
 * all riders' telemetry for a given groupRideId in one call.
 */
const telemetrySchema = new mongoose.Schema({
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
  userId: { type: String, required: true, index: true },
  groupRideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },

  // Parallel arrays — same length, one entry per ~1 s GPS sample
  speed: [Number],          // km/h
  gForce: [Number],         // G
  leanAngle: [Number],      // degrees (negative=left, positive=right)
  timestamp: [Number],      // Absolute unix ms
  cumDistanceM: [Number]    // Cumulative GPS haversine distance in metres
}, {
  timestamps: true
});

// One telemetry document per ride
telemetrySchema.index({ rideId: 1 }, { unique: true });
// Fast lookup for group ride comparison
telemetrySchema.index({ groupRideId: 1, userId: 1 });

module.exports = mongoose.model('Telemetry', telemetrySchema);
