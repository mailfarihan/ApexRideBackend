const mongoose = require('mongoose');

const tripSchema = new mongoose.Schema({
  creatorId: { type: String, required: true, index: true },
  creatorName: { type: String, required: true },
  
  title: { type: String, required: true },
  description: { type: String, default: '' },
  
  // Meeting point
  meetupLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true } // [lng, lat]
  },
  meetupAddress: { type: String, default: '' },
  
  // Timing
  dateTime: { type: Number, required: true }, // Unix timestamp
  
  // Linked route (optional)
  linkedRouteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
  
  // Participants
  maxRiders: { type: Number, default: 0 }, // 0 = unlimited
  attendeeIds: [{ type: String }],
  
  // Status
  status: { 
    type: String, 
    enum: ['upcoming', 'ongoing', 'completed', 'cancelled'],
    default: 'upcoming'
  }
}, {
  timestamps: true
});

// Indexes
tripSchema.index({ meetupLocation: '2dsphere' });
tripSchema.index({ dateTime: 1 });
tripSchema.index({ status: 1, dateTime: 1 });

module.exports = mongoose.model('Trip', tripSchema);
