const Ride = require('../models/Ride');
const Circle = require('../models/Circle');
const RideShare = require('../models/RideShare');

/**
 * Determine whether `userId` may view `rideId`.
 * Owner: always allowed.
 * Else: allowed if any RideShare row matches the user directly
 *   OR matches a circle the user belongs to.
 *
 * Returns the Ride document on success, or null on denial / not-found.
 */
async function canAccessRide(userId, rideId) {
  if (!rideId) return null;
  const ride = await Ride.findById(rideId).lean();
  if (!ride) return null;
  if (ride.userId === userId) return ride;

  const userMatch = await RideShare.findOne({
    rideId,
    'sharedWith.type': 'user',
    'sharedWith.id': userId
  }).lean();
  if (userMatch) return ride;

  const memberCircles = await Circle.find({ 'members.userId': userId }).select('_id').lean();
  if (memberCircles.length === 0) return null;
  const circleIds = memberCircles.map(c => c._id.toString());

  const circleMatch = await RideShare.findOne({
    rideId,
    'sharedWith.type': 'circle',
    'sharedWith.id': { $in: circleIds }
  }).lean();
  if (circleMatch) return ride;

  return null;
}

/**
 * Auto-share: when a ride is finalized for `ownerId`, create a circle-scoped
 * RideShare row for every circle the owner belongs to (member or owner).
 * Idempotent thanks to the unique index on (rideId, sharedWith.type, sharedWith.id).
 */
async function autoShareRide(rideId, ownerId) {
  try {
    const circles = await Circle.find({
      $or: [{ ownerId }, { 'members.userId': ownerId }]
    }).select('_id').lean();
    if (circles.length === 0) return 0;

    const docs = circles.map(c => ({
      rideId,
      ownerId,
      sharedWith: { type: 'circle', id: c._id.toString() },
      permissions: ['summary', 'telemetry']
    }));

    await RideShare.insertMany(docs, { ordered: false }).catch(err => {
      // Duplicate-key errors are expected on re-sync; swallow them.
      if (err && err.code !== 11000) {
        console.error('autoShareRide bulk insert warning:', err.message);
      }
    });
    return docs.length;
  } catch (error) {
    console.error('autoShareRide error:', error);
    return 0;
  }
}

module.exports = { canAccessRide, autoShareRide };
