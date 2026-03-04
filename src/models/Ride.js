const mongoose = require('mongoose');

const locationPointSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
  alt: Number,
  speed: Number,
  bearing: Number,
  timestamp: Number
}, { _id: false });

const rideSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  localId: { type: Number, required: true }, // Local Room DB ID
  
  // Time
  startTime: { type: Number, required: true },
  endTime: { type: Number },
  
  // Stats
  distance: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  avgSpeed: { type: Number, default: 0 },
  maxSpeed: { type: Number, default: 0 },
  
  // Route data - stored as JSON string for efficiency
  routePointsJson: { type: String, default: '[]' },
  
  // Scores
  scenicScore: { type: Number, default: 0 },
  twistyScore: { type: Number, default: 0 },
  
  // User data
  title: { type: String, default: '' },
  notes: { type: String, default: '' },
  region: { type: String, default: '' },
  
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
