const mongoose = require('mongoose');

/**
 * GroupRide (formerly Trip) - represents a planned group riding event
 * Users can create public group rides, others can join, and when the ride
 * is started, each participant's tracked ride is linked back to this group ride.
 */
const groupRideSchema = new mongoose.Schema({
  // Creator info
  creatorId: { type: String, required: true, index: true },
  creatorName: { type: String, required: true },
  creatorPhotoUrl: { type: String, default: '' },
  
  // Event details
  title: { type: String, required: true },
  description: { type: String, default: '' },
  
  // Meeting point
  meetupLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true } // [lng, lat]
  },
  meetupAddress: { type: String, default: '' },
  
  // Timing
  dateTime: { type: Number, required: true }, // Unix timestamp for meetup
  estimatedDuration: { type: Number, default: 0 }, // minutes
  
  // Route info (optional pre-planned route)
  linkedRouteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
  estimatedDistance: { type: Number, default: 0 }, // km
  difficulty: { type: String, enum: ['easy', 'moderate', 'challenging', 'expert'], default: 'moderate' },
  
  // Visibility & Participants
  isPublic: { type: Boolean, default: true },
  maxRiders: { type: Number, default: 0 }, // 0 = unlimited
  attendeeIds: [{ type: String }], // User IDs who joined
  
  // Linked rides (populated after ride is completed)
  completedRideIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Ride' }],
  
  // Status
  status: { 
    type: String, 
    enum: ['upcoming', 'ongoing', 'completed', 'cancelled'],
    default: 'upcoming'
  },
  
  // Stats (populated after completion)
  actualStartTime: { type: Number },
  actualEndTime: { type: Number },
  totalParticipants: { type: Number, default: 0 }
}, {
  timestamps: true
});

// Indexes for discovery
groupRideSchema.index({ meetupLocation: '2dsphere' });
groupRideSchema.index({ dateTime: 1 });
groupRideSchema.index({ status: 1, dateTime: 1 });
groupRideSchema.index({ isPublic: 1, status: 1, dateTime: 1 });

// Keep the model name as 'Trip' for backwards compatibility with existing data
module.exports = mongoose.model('Trip', groupRideSchema);
