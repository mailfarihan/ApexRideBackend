const mongoose = require('mongoose');

const routeSchema = new mongoose.Schema({
  creatorId: { type: String, required: true, index: true },
  creatorName: { type: String, required: true },
  creatorPhotoUrl: { type: String, default: '' },
  sourceRideId: { type: String, default: null }, // Links to original ride if published from one
  title: { type: String, required: true },
  description: { type: String, default: '' },
  region: { type: String, default: '' },
  
  // Geo data
  startLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true } // [lng, lat]
  },
  endLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number] } // [lng, lat]
  },
  
  // Encoded polyline for efficient storage
  encodedPolyline: { type: String, default: '' },
  
  // Stats
  distance: { type: Number, required: true }, // meters
  duration: { type: Number, required: true }, // milliseconds
  avgSpeed: { type: Number, default: 0 },
  maxSpeed: { type: Number, default: 0 },
  elevationGain: { type: Number, default: 0 },
  
  // Scores
  scenicScore: { type: Number, default: 0, min: 0, max: 100 },
  twistyScore: { type: Number, default: 0, min: 0, max: 100 },
  
  // Ratings
  ratingSum: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
  ratingAvg: { type: Number, default: 0 },
  
  // Map preview images (generated via Google Static Maps API)
  mapImageLightUrl: { type: String, default: '' },
  mapImageDarkUrl: { type: String, default: '' },
  
  // Metadata
  tags: [String],
  isPublic: { type: Boolean, default: true }
}, {
  timestamps: true
});

// 2dsphere index for geo queries
routeSchema.index({ startLocation: '2dsphere' });
routeSchema.index({ endLocation: '2dsphere' });
routeSchema.index({ createdAt: -1 });
routeSchema.index({ scenicScore: -1 });
routeSchema.index({ ratingAvg: -1 });

module.exports = mongoose.model('Route', routeSchema);
