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
  
  // ==================== NEW: Processed route data ====================
  // Encoded polyline for efficient route storage (Google Polyline Algorithm)
  encodedPolyline: { type: String, default: '' },
  
  // Simplified coordinate samples for replay feature
  samples: [{
    lat: Number,
    lon: Number,
    t: Number      // Relative time in seconds from ride start
  }],
  
  // Sampled telemetry data for graphs (parallel arrays)
  telemetry: {
    speed: [Number],          // km/h
    gForce: [Number],         // G
    leanAngle: [Number],      // degrees (negative=left, positive=right)
    timestamp: [Number],      // Absolute unix ms
    cumDistanceM: [Number]    // Cumulative GPS distance in metres
  },
  
  // Ride events with location and telemetry snapshot
  events: [{
    type: { type: String },  // RAPID_ACCELERATION, HARD_BRAKING, EXTREME_LEAN, etc.
    latitude: Number,
    longitude: Number,
    value: Number,           // Primary trigger value
    severity: String,        // MODERATE, HIGH, EXTREME
    speed: Number,           // km/h at event
    leanAngle: Number,       // degrees at event
    gForce: Number,          // G at event
    timestamp: Number        // Absolute unix ms
  }],
  
  // ==================== LEGACY (for backward compatibility) ====================
  // Route data - stored as JSON string (deprecated, use encodedPolyline + samples)
  routePointsJson: { type: String, default: '[]' },
  
  // Events JSON (deprecated, use events array)
  eventsJson: { type: String, default: '[]' },
  
  // Scores (0-100)
  scenicScore: { type: Number, default: 0 },
  twistyScore: { type: Number, default: 0 },
  
  // User data
  title: { type: String, default: '' },
  notes: { type: String, default: '' },
  region: { type: String, default: '' },
  isPublic: { type: Boolean, default: false },
  
  // Map preview images (generated via Google Static Maps API)
  mapImageLightUrl: { type: String, default: '' },
  mapImageDarkUrl: { type: String, default: '' },
  
  // Start location for quick geo lookups
  startLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number] } // [lng, lat]
  },
  startAddress: { type: String, default: '' },
  
  // End location
  endLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number] } // [lng, lat]
  },
  endAddress: { type: String, default: '' }
}, {
  timestamps: true
});

// Compound index for user + localId (for sync)
rideSchema.index({ userId: 1, localId: 1 }, { unique: true });
rideSchema.index({ userId: 1, startTime: -1 });

module.exports = mongoose.model('Ride', rideSchema);
