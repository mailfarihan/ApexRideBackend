const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');
const { generateMapImages, deleteMapImages } = require('../services/mapImage');

// GET /api/rides - Get user's synced rides
router.get('/', async (req, res) => {
  try {
    const rides = await Ride.find({ userId: req.user.uid })
      .sort({ startTime: -1 })
      .lean();
    
    // Ensure all rides have default values for missing fields
    // Exclude legacy large fields if new format is available
    const ridesWithDefaults = rides.map(ride => {
      const hasNewFormat = ride.encodedPolyline && ride.encodedPolyline.length > 0;
      return {
        ...ride,
        distance: ride.distance ?? 0,
        duration: ride.duration ?? 0,
        avgSpeed: ride.avgSpeed ?? 0,
        maxSpeed: ride.maxSpeed ?? 0,
        elevationGain: ride.elevationGain ?? 0,
        maxLeanAngle: ride.maxLeanAngle ?? 0,
        avgLeanAngle: ride.avgLeanAngle ?? 0,
        maxGForce: ride.maxGForce ?? 0,
        // New format fields
        encodedPolyline: ride.encodedPolyline ?? '',
        samples: ride.samples ?? [],
        telemetry: ride.telemetry ?? { speed: [], gForce: [], leanAngle: [], timestamp: [] },
        events: ride.events ?? [],
        // Legacy fields (only include if no new format)
        routePointsJson: hasNewFormat ? undefined : (ride.routePointsJson ?? '[]'),
        eventsJson: hasNewFormat ? undefined : (ride.eventsJson ?? '[]'),
        // Map images
        mapImageLightUrl: ride.mapImageLightUrl ?? '',
        mapImageDarkUrl: ride.mapImageDarkUrl ?? '',
        // Other fields
        scenicScore: ride.scenicScore ?? 0,
        twistyScore: ride.twistyScore ?? 0,
        title: ride.title ?? '',
        notes: ride.notes ?? '',
        region: ride.region ?? '',
        isPublic: ride.isPublic ?? false
      };
    });
    
    res.json(ridesWithDefaults);
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
        // Determine if using new format (has encodedPolyline) or legacy
        const hasNewFormat = ride.encodedPolyline && ride.encodedPolyline.length > 0;
        
        // Build update document
        const updateDoc = {
          userId: req.user.uid,
          localId: ride.localId,
          startTime: ride.startTime,
          endTime: ride.endTime,
          distance: ride.distance,
          duration: ride.duration,
          avgSpeed: ride.avgSpeed,
          maxSpeed: ride.maxSpeed,
          elevationGain: ride.elevationGain,
          maxLeanAngle: ride.maxLeanAngle,
          avgLeanAngle: ride.avgLeanAngle,
          maxGForce: ride.maxGForce,
          scenicScore: ride.scenicScore,
          twistyScore: ride.twistyScore,
          title: ride.title,
          notes: ride.notes,
          region: ride.region,
          isPublic: ride.isPublic,
          startLocation: ride.startLat && ride.startLng ? {
            type: 'Point',
            coordinates: [ride.startLng, ride.startLat]
          } : undefined
        };
        
        // Add new format fields if present
        if (hasNewFormat) {
          updateDoc.encodedPolyline = ride.encodedPolyline;
          updateDoc.samples = ride.samples || [];
          updateDoc.telemetry = ride.telemetry || {};
          updateDoc.events = ride.events || [];
          // Clear legacy fields when new format is used
          updateDoc.routePointsJson = '';
          updateDoc.eventsJson = '[]';
        } else {
          // Legacy format
          updateDoc.routePointsJson = ride.routePointsJson;
          updateDoc.eventsJson = ride.eventsJson;
        }
        
        // Upsert: update if exists, insert if not
        const existingRide = await Ride.findOne({ userId: req.user.uid, localId: ride.localId }).lean();
        const result = await Ride.findOneAndUpdate(
          { 
            userId: req.user.uid, 
            localId: ride.localId 
          },
          updateDoc,
          { upsert: true, new: true }
        );
        
        // Generate map images in background if new format and no images yet
        if (hasNewFormat && !existingRide?.mapImageLightUrl) {
          generateMapImages(ride.encodedPolyline, 'ride', ride.mapStyle || {}).then(({ mapImageLightUrl, mapImageDarkUrl }) => {
            if (mapImageLightUrl) {
              Ride.updateOne({ _id: result._id }, { mapImageLightUrl, mapImageDarkUrl }).catch(() => {});
            }
          }).catch(() => {});
        }
        
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
    
    // Determine if using new format
    const hasNewFormat = ride.encodedPolyline && ride.encodedPolyline.length > 0;
    
    const updateDoc = {
      userId: req.user.uid,
      localId: ride.localId,
      startTime: ride.startTime,
      endTime: ride.endTime,
      distance: ride.distance,
      duration: ride.duration,
      avgSpeed: ride.avgSpeed,
      maxSpeed: ride.maxSpeed,
      elevationGain: ride.elevationGain,
      maxLeanAngle: ride.maxLeanAngle,
      avgLeanAngle: ride.avgLeanAngle,
      maxGForce: ride.maxGForce,
      scenicScore: ride.scenicScore,
      twistyScore: ride.twistyScore,
      title: ride.title,
      notes: ride.notes,
      region: ride.region,
      isPublic: ride.isPublic,
      startLocation: ride.startLat && ride.startLng ? {
        type: 'Point',
        coordinates: [ride.startLng, ride.startLat]
      } : undefined
    };
    
    if (hasNewFormat) {
      updateDoc.encodedPolyline = ride.encodedPolyline;
      updateDoc.samples = ride.samples || [];
      updateDoc.telemetry = ride.telemetry || {};
      updateDoc.events = ride.events || [];
      updateDoc.routePointsJson = '';
      updateDoc.eventsJson = '[]';
    } else {
      updateDoc.routePointsJson = ride.routePointsJson;
      updateDoc.eventsJson = ride.eventsJson;
    }
    
    const result = await Ride.findOneAndUpdate(
      { 
        userId: req.user.uid, 
        localId: ride.localId 
      },
      updateDoc,
      { upsert: true, new: true }
    );
    
    // Generate map images if polyline available
    let mapImageLightUrl = '';
    let mapImageDarkUrl = '';
    if (hasNewFormat) {
      const images = await generateMapImages(ride.encodedPolyline, 'ride', ride.mapStyle || {});
      mapImageLightUrl = images.mapImageLightUrl;
      mapImageDarkUrl = images.mapImageDarkUrl;
      if (mapImageLightUrl) {
        await Ride.updateOne({ _id: result._id }, { mapImageLightUrl, mapImageDarkUrl });
      }
    }
    
    res.status(201).json({ 
      id: result._id.toString(),
      localId: ride.localId,
      mapImageLightUrl,
      mapImageDarkUrl,
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
    
    // Delete map images from Firebase Storage
    deleteMapImages(result.mapImageLightUrl, result.mapImageDarkUrl).catch(() => {});
    
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
        avgLeanAngle: ride.avgLeanAngle,
        maxGForce: ride.maxGForce
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
