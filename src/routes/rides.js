const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');

// GET /api/rides - Get user's synced rides
router.get('/', async (req, res) => {
  try {
    const rides = await Ride.find({ userId: req.user.uid })
      .sort({ startTime: -1 })
      .lean();
    
    res.json(rides);
  } catch (error) {
    console.error('Get rides error:', error);
    res.status(500).json({ error: 'Failed to get rides' });
  }
});

// POST /api/rides/sync - Sync multiple rides at once
router.post('/sync', async (req, res) => {
  try {
    const { rides } = req.body; // Array of rides to sync
    
    if (!Array.isArray(rides)) {
      return res.status(400).json({ error: 'rides must be an array' });
    }
    
    const results = [];
    
    for (const ride of rides) {
      try {
        // Upsert: update if exists, insert if not
        const result = await Ride.findOneAndUpdate(
          { 
            userId: req.user.uid, 
            localId: ride.localId 
          },
          {
            userId: req.user.uid,
            localId: ride.localId,
            startTime: ride.startTime,
            endTime: ride.endTime,
            distance: ride.distance,
            duration: ride.duration,
            avgSpeed: ride.avgSpeed,
            maxSpeed: ride.maxSpeed,
            routePointsJson: ride.routePointsJson,
            scenicScore: ride.scenicScore,
            twistyScore: ride.twistyScore,
            title: ride.title,
            notes: ride.notes,
            region: ride.region,
            startLocation: ride.startLat && ride.startLng ? {
              type: 'Point',
              coordinates: [ride.startLng, ride.startLat]
            } : undefined
          },
          { upsert: true, new: true }
        );
        
        results.push({
          localId: ride.localId,
          mongoId: result._id.toString(),
          status: 'synced'
        });
      } catch (err) {
        results.push({
          localId: ride.localId,
          status: 'failed',
          error: err.message
        });
      }
    }
    
    res.json({ 
      synced: results.filter(r => r.status === 'synced').length,
      failed: results.filter(r => r.status === 'failed').length,
      results 
    });
  } catch (error) {
    console.error('Sync rides error:', error);
    res.status(500).json({ error: 'Failed to sync rides' });
  }
});

// POST /api/rides - Sync single ride
router.post('/', async (req, res) => {
  try {
    const ride = req.body;
    
    const result = await Ride.findOneAndUpdate(
      { 
        userId: req.user.uid, 
        localId: ride.localId 
      },
      {
        userId: req.user.uid,
        localId: ride.localId,
        startTime: ride.startTime,
        endTime: ride.endTime,
        distance: ride.distance,
        duration: ride.duration,
        avgSpeed: ride.avgSpeed,
        maxSpeed: ride.maxSpeed,
        routePointsJson: ride.routePointsJson,
        scenicScore: ride.scenicScore,
        twistyScore: ride.twistyScore,
        title: ride.title,
        notes: ride.notes,
        region: ride.region,
        startLocation: ride.startLat && ride.startLng ? {
          type: 'Point',
          coordinates: [ride.startLng, ride.startLat]
        } : undefined
      },
      { upsert: true, new: true }
    );
    
    res.status(201).json({ 
      id: result._id.toString(),
      localId: ride.localId,
      message: 'Ride synced' 
    });
  } catch (error) {
    console.error('Sync ride error:', error);
    res.status(500).json({ error: 'Failed to sync ride' });
  }
});

// DELETE /api/rides/:localId - Delete a synced ride
router.delete('/:localId', async (req, res) => {
  try {
    const result = await Ride.findOneAndDelete({
      userId: req.user.uid,
      localId: parseInt(req.params.localId)
    });
    
    if (!result) {
      return res.status(404).json({ error: 'Ride not found' });
    }
    
    res.json({ message: 'Ride deleted from cloud' });
  } catch (error) {
    console.error('Delete ride error:', error);
    res.status(500).json({ error: 'Failed to delete ride' });
  }
});

// PUT /api/rides/:localId - Update a synced ride
router.put('/:localId', async (req, res) => {
  try {
    const ride = req.body;
    const result = await Ride.findOneAndUpdate(
      { 
        userId: req.user.uid, 
        localId: parseInt(req.params.localId) 
      },
      {
        title: ride.title,
        notes: ride.notes,
        isPublic: ride.isPublic,
        elevationGain: ride.elevationGain,
        maxLeanAngle: ride.maxLeanAngle,
        avgLeanAngle: ride.avgLeanAngle
      },
      { new: true }
    );
    
    if (!result) {
      return res.status(404).json({ error: 'Ride not found' });
    }
    
    res.json({ message: 'Ride updated', id: result._id.toString() });
  } catch (error) {
    console.error('Update ride error:', error);
    res.status(500).json({ error: 'Failed to update ride' });
  }
});

module.exports = router;
