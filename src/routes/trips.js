const express = require('express');
const router = express.Router();
const Trip = require('../models/Trip');

// GET /api/trips - Get user's planned trips
router.get('/', async (req, res) => {
  try {
    const trips = await Trip.find({ 
      creatorId: req.user.uid 
    })
    .sort({ plannedDate: 1 })
    .lean();
    
    res.json(trips);
  } catch (error) {
    console.error('Get trips error:', error);
    res.status(500).json({ error: 'Failed to get trips' });
  }
});

// GET /api/trips/nearby - Find upcoming trips near a location
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radiusKm = 50, limit = 20 } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng required' });
    }
    
    const trips = await Trip.aggregate([
      {
        $geoNear: {
          near: {
            type: 'Point',
            coordinates: [parseFloat(lng), parseFloat(lat)]
          },
          distanceField: 'distance',
          maxDistance: parseFloat(radiusKm) * 1000, // meters
          spherical: true,
          query: {
            isPublic: true,
            plannedDate: { $gte: new Date() } // Only future trips
          }
        }
      },
      { $limit: parseInt(limit) },
      {
        $project: {
          title: 1,
          description: 1,
          plannedDate: 1,
          meetupLocation: 1,
          creatorId: 1,
          routeId: 1,
          rideStyle: 1,
          maxParticipants: 1,
          participants: 1,
          participantCount: { $size: '$participants' },
          distance: { $divide: ['$distance', 1000] } // km
        }
      }
    ]);
    
    res.json(trips);
  } catch (error) {
    console.error('Get nearby trips error:', error);
    res.status(500).json({ error: 'Failed to get nearby trips' });
  }
});

// POST /api/trips - Create a new trip
router.post('/', async (req, res) => {
  try {
    const trip = new Trip({
      ...req.body,
      creatorId: req.user.uid,
      meetupLocation: req.body.meetupLat && req.body.meetupLng ? {
        type: 'Point',
        coordinates: [req.body.meetupLng, req.body.meetupLat]
      } : undefined,
      participants: [req.user.uid] // Creator auto-joins
    });
    
    await trip.save();
    res.status(201).json(trip);
  } catch (error) {
    console.error('Create trip error:', error);
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

// PUT /api/trips/:id - Update a trip
router.put('/:id', async (req, res) => {
  try {
    const trip = await Trip.findOne({
      _id: req.params.id,
      creatorId: req.user.uid // Only creator can edit
    });
    
    if (!trip) {
      return res.status(404).json({ error: 'Trip not found or not authorized' });
    }
    
    // Update fields
    const updateFields = ['title', 'description', 'plannedDate', 'routeId', 
                         'rideStyle', 'maxParticipants', 'isPublic'];
    updateFields.forEach(field => {
      if (req.body[field] !== undefined) {
        trip[field] = req.body[field];
      }
    });
    
    // Update location if provided
    if (req.body.meetupLat && req.body.meetupLng) {
      trip.meetupLocation = {
        type: 'Point',
        coordinates: [req.body.meetupLng, req.body.meetupLat]
      };
    }
    
    await trip.save();
    res.json(trip);
  } catch (error) {
    console.error('Update trip error:', error);
    res.status(500).json({ error: 'Failed to update trip' });
  }
});

// POST /api/trips/:id/join - Join a trip
router.post('/:id/join', async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);
    
    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }
    
    if (!trip.isPublic && trip.creatorId !== req.user.uid) {
      return res.status(403).json({ error: 'This trip is private' });
    }
    
    if (trip.participants.includes(req.user.uid)) {
      return res.status(400).json({ error: 'Already joined this trip' });
    }
    
    if (trip.maxParticipants && trip.participants.length >= trip.maxParticipants) {
      return res.status(400).json({ error: 'Trip is full' });
    }
    
    trip.participants.push(req.user.uid);
    await trip.save();
    
    res.json({ message: 'Joined trip', participantCount: trip.participants.length });
  } catch (error) {
    console.error('Join trip error:', error);
    res.status(500).json({ error: 'Failed to join trip' });
  }
});

// POST /api/trips/:id/leave - Leave a trip
router.post('/:id/leave', async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);
    
    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }
    
    if (trip.creatorId === req.user.uid) {
      return res.status(400).json({ error: 'Creator cannot leave. Delete the trip instead.' });
    }
    
    const idx = trip.participants.indexOf(req.user.uid);
    if (idx === -1) {
      return res.status(400).json({ error: 'Not a participant of this trip' });
    }
    
    trip.participants.splice(idx, 1);
    await trip.save();
    
    res.json({ message: 'Left trip', participantCount: trip.participants.length });
  } catch (error) {
    console.error('Leave trip error:', error);
    res.status(500).json({ error: 'Failed to leave trip' });
  }
});

// DELETE /api/trips/:id - Delete a trip
router.delete('/:id', async (req, res) => {
  try {
    const result = await Trip.findOneAndDelete({
      _id: req.params.id,
      creatorId: req.user.uid // Only creator can delete
    });
    
    if (!result) {
      return res.status(404).json({ error: 'Trip not found or not authorized' });
    }
    
    res.json({ message: 'Trip deleted' });
  } catch (error) {
    console.error('Delete trip error:', error);
    res.status(500).json({ error: 'Failed to delete trip' });
  }
});

module.exports = router;
