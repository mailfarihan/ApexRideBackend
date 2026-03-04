const mongoose = require('mongoose');

/**
 * Location point with sensor data
 * Units:
 * - lat/lng: degrees
 * - alt: meters
 * - speed: meters per second (m/s)
 * - bearing: degrees (0-360)
 * - leanAngle: degrees (negative = left, positive = right)
 */
const locationPointSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
  alt: Number,
  speed: Number,
  bearing: Number,
  leanAngle: Number,  // Lean angle in degrees
  timestamp: Number
}, { _id: false });

/**
 * Ride schema
 * Units:
 * - distance: meters
 * - duration: milliseconds
 * - avgSpeed/maxSpeed: meters per second (m/s)
 * - elevationGain: meters
 * - maxLeanAngle: degrees (absolute max)
 * - avgLeanAngle: degrees (average of absolute values)
 */
const rideSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  localId: { type: Number, required: true }, // Local Room DB ID
  
  // Time
  startTime: { type: Number, required: true },
  endTime: { type: Number },
  
  // Stats (in base units - see header comment)
  distance: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  avgSpeed: { type: Number, default: 0 },
  maxSpeed: { type: Number, default: 0 },
  elevationGain: { type: Number, default: 0 },
  
  // Lean angle stats
  maxLeanAngle: { type: Number, default: 0 },
  avgLeanAngle: { type: Number, default: 0 },
  
  // G-Force stats
  maxGForce: { type: Number, default: 0 },
  
  // Route data - stored as JSON string for efficiency
  routePointsJson: { type: String, default: '[]' },
  
  // Events (hard braking, hard acceleration, etc.)
  eventsJson: { type: String, default: '[]' },
  
  // Scores (0-100)
  scenicScore: { type: Number, default: 0 },
  twistyScore: { type: Number, default: 0 },
  
  // User data
  title: { type: String, default: '' },
  notes: { type: String, default: '' },
  region: { type: String, default: '' },
  isPublic: { type: Boolean, default: false },
  
  // Start location for quick geo lookups
  startLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number] } // [lng, lat]
  }
}, {
  timestamps: true
});

// Compound index for user + localId (for sync)
rideSchema.index({ userId: 1, localId: 1 }, { unique: true });
rideSchema.index({ userId: 1, startTime: -1 });

module.exports = mongoose.model('Ride', rideSchema);
