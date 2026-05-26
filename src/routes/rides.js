const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');
const Telemetry = require('../models/Telemetry');
const Trip = require('../models/Trip');
const { generateMapImages, deleteMapImages } = require('../services/mapImage');

// GET /api/rides - Get user's synced rides
router.get('/', async (req, res) => {
  try {
    const rides = await Ride.find({ userId: req.user.uid })
      .sort({ startTime: -1 })
      .lean();
    
    // Ensure all rides have default values for missing fields
    // Exclude legacy large fields if new format is available
    // Telemetry is now in a separate collection — omit from list response
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
        telemetry: undefined, // Lazy-loaded via /api/telemetry/:rideId
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
          } : undefined,
          startAddress: ride.startAddress || '',
          endLocation: ride.endLat && ride.endLng ? {
            type: 'Point',
            coordinates: [ride.endLng, ride.endLat]
          } : undefined,
          endAddress: ride.endAddress || ''
        };
        
        // Handle groupRideId — client may send it directly, or we auto-detect
        if (ride.groupRideId) {
          updateDoc.groupRideId = ride.groupRideId;
        } else if (ride.startTime) {
          // Fallback auto-link: only match ONGOING group rides (not completed)
          // AND gate by proximity/time so a later, unrelated ride (e.g. user
          // got home, then rode again hours later while the creator forgot to
          // end the group ride) does not get mis-linked.
          //
          // Required:
          //   - ride.startTime within AUTO_LINK_MAX_AGE_MS of trip.actualStartTime/dateTime
          //   - ride.startLat/lng within AUTO_LINK_MAX_DIST_M of trip.startLocation
          try {
            const AUTO_LINK_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
            const AUTO_LINK_MAX_DIST_M = 5000;               // 5 km
            const candidates = await Trip.find({
              attendeeIds: req.user.uid,
              status: 'ongoing',
              $or: [
                { actualStartTime: { $lte: ride.startTime } },
                { dateTime: { $lte: ride.startTime } }
              ]
            }).lean();

            const haversineM = (lat1, lng1, lat2, lng2) => {
              const R = 6371000;
              const toRad = (d) => (d * Math.PI) / 180;
              const dLat = toRad(lat2 - lat1);
              const dLng = toRad(lng2 - lng1);
              const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
              return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
            };

            let matchingTrip = null;
            for (const trip of candidates) {
              const tripStart = trip.actualStartTime || trip.dateTime;
              if (!tripStart) continue;
              if (ride.startTime - tripStart > AUTO_LINK_MAX_AGE_MS) continue;
              const tripCoords = trip.startLocation && trip.startLocation.coordinates;
              if (tripCoords && tripCoords.length === 2 &&
                  typeof ride.startLat === 'number' && typeof ride.startLng === 'number') {
                const dist = haversineM(ride.startLat, ride.startLng, tripCoords[1], tripCoords[0]);
                if (dist > AUTO_LINK_MAX_DIST_M) continue;
              }
              // Tie-break: pick the trip whose start is closest in time to ride.startTime
              if (!matchingTrip || tripStart > (matchingTrip.actualStartTime || matchingTrip.dateTime)) {
                matchingTrip = trip;
              }
            }
            if (matchingTrip) {
              updateDoc.groupRideId = matchingTrip._id;
            }
          } catch (matchErr) {
            console.error('Auto-link match error:', matchErr.message);
          }
        }
        
        // Add new format fields if present
        if (hasNewFormat) {
          updateDoc.encodedPolyline = ride.encodedPolyline;
          updateDoc.samples = ride.samples || [];
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
          {
            $set: updateDoc,
            // Remove legacy telemetry from Ride document — now stored in Telemetry collection
            ...(hasNewFormat ? { $unset: { telemetry: 1 } } : {})
          },
          { upsert: true, new: true }
        );

        // Write telemetry to separate collection (fire-and-forget for speed)
        if (hasNewFormat && ride.telemetry) {
          Telemetry.findOneAndUpdate(
            { rideId: result._id },
            {
              $set: {
                userId: req.user.uid,
                groupRideId: updateDoc.groupRideId || null,
                speed: ride.telemetry.speed || [],
                gForce: ride.telemetry.gForce || [],
                leanAngle: ride.telemetry.leanAngle || [],
                timestamp: ride.telemetry.timestamp || [],
                cumDistanceM: ride.telemetry.cumDistanceM || []
              }
            },
            { upsert: true }
          ).catch(err => console.error('Telemetry upsert error:', err.message));
        }
        
        // Auto-link ride to group ride if groupRideId is set
        if (updateDoc.groupRideId) {
          const gid = updateDoc.groupRideId;
          Trip.findByIdAndUpdate(
            gid,
            { $addToSet: { completedRideIds: result._id } }
          ).catch(err => console.error('Auto-link to group ride error:', err.message));
        }
        
                // Generate map images synchronously so URLs are returned in the sync response
        // Regenerate if: no image yet, OR this is a different ride reusing the same localId
        // (e.g. after account deletion/reinstall — Room auto-increment resets)
        const isDifferentRide = existingRide && existingRide.startTime !== ride.startTime;
        let mapImageLightUrl = existingRide?.mapImageLightUrl || '';
        let mapImageDarkUrl = existingRide?.mapImageDarkUrl || '';
        const needsImageGeneration = hasNewFormat && (!existingRide?.mapImageLightUrl || isDifferentRide);
        if (needsImageGeneration) {
          try {
            // Delete stale images from Firebase Storage if this is a localId reuse
            if (isDifferentRide && existingRide.mapImageLightUrl) {
              deleteMapImages(existingRide.mapImageLightUrl, existingRide.mapImageDarkUrl).catch(() => {});
            }
            const urls = await generateMapImages(ride.encodedPolyline, 'ride', ride.mapStyle || {});
            mapImageLightUrl = urls.mapImageLightUrl || '';
            mapImageDarkUrl = urls.mapImageDarkUrl || '';
            if (mapImageLightUrl) {
              await Ride.updateOne({ _id: result._id }, { mapImageLightUrl, mapImageDarkUrl });
            }
          } catch (imgErr) {
            console.error('Map image generation failed:', imgErr.message);
          }
        }

        results.push({
          localId: ride.localId,
          mongoId: result._id.toString(),
          status: 'synced',
          mapImageLightUrl,
          mapImageDarkUrl
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
      } : undefined,
      startAddress: ride.startAddress || '',
      endLocation: ride.endLat && ride.endLng ? {
        type: 'Point',
        coordinates: [ride.endLng, ride.endLat]
      } : undefined,
      endAddress: ride.endAddress || ''
    };
    
    if (hasNewFormat) {
      updateDoc.encodedPolyline = ride.encodedPolyline;
      updateDoc.samples = ride.samples || [];
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
      {
        $set: updateDoc,
        ...(hasNewFormat ? { $unset: { telemetry: 1 } } : {})
      },
      { upsert: true, new: true }
    );

    // Write telemetry to separate collection
    if (hasNewFormat && ride.telemetry) {
      await Telemetry.findOneAndUpdate(
        { rideId: result._id },
        {
          $set: {
            userId: req.user.uid,
            speed: ride.telemetry.speed || [],
            gForce: ride.telemetry.gForce || [],
            leanAngle: ride.telemetry.leanAngle || [],
            timestamp: ride.telemetry.timestamp || [],
            cumDistanceM: ride.telemetry.cumDistanceM || []
          }
        },
        { upsert: true }
      );
    }
    
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
    
    // Delete telemetry from separate collection
    Telemetry.deleteMany({ rideId: result._id }).catch(() => {});
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
