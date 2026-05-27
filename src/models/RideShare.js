const mongoose = require('mongoose');

/**
 * RideShare grants visibility into a ride for either a single user or every
 * member of a circle. Created automatically when a ride is finalized while
 * its owner belongs to one or more circles.
 */
const sharedWithSchema = new mongoose.Schema({
  type: { type: String, enum: ['user', 'circle'], required: true },
  id: { type: String, required: true }
}, { _id: false });

const rideShareSchema = new mongoose.Schema({
  rideId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: 'Ride' },
  ownerId: { type: String, required: true, index: true },
  sharedWith: { type: sharedWithSchema, required: true },
  permissions: {
    type: [String],
    enum: ['summary', 'telemetry', 'live'],
    default: ['summary', 'telemetry']
  },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null }
});

rideShareSchema.index({ 'sharedWith.type': 1, 'sharedWith.id': 1, createdAt: -1 });
rideShareSchema.index({ rideId: 1, 'sharedWith.type': 1, 'sharedWith.id': 1 }, { unique: true });

module.exports = mongoose.model('RideShare', rideShareSchema);
