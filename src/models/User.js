const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Firebase UID - primary identifier
  firebaseUid: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Profile info
  displayName: {
    type: String,
    default: 'Rider'
  },
  email: {
    type: String
  },
  photoUrl: {
    type: String,
    default: null
  },
  
  // Extended profile
  bio: {
    type: String,
    maxlength: 500,
    default: ''
  },
  
  // Motorcycle info
  motorcycle: {
    make: { type: String, default: '' },
    model: { type: String, default: '' },
    year: { type: Number, default: null }
  },
  
  // Stats (can be computed or cached)
  stats: {
    totalRides: { type: Number, default: 0 },
    totalDistance: { type: Number, default: 0 },
    publishedRoutes: { type: Number, default: 0 }
  },
  
  // Preferences
  preferences: {
    units: { type: String, enum: ['metric', 'imperial'], default: 'metric' },
    notifications: { type: Boolean, default: true }
  },
  
  // Social
  followers: [{ type: String }],  // Firebase UIDs
  following: [{ type: String }],  // Firebase UIDs
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  
  // Soft-delete: scheduled deletion date (30 days from request)
  deletionScheduledAt: {
    type: Date,
    default: null
  },
  deletionReason: {
    type: String,
    default: null
  },
  deletionFeedback: {
    type: String,
    default: null
  }
});

// Update timestamp on save
userSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('User', userSchema);
