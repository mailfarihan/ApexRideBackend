const express = require('express');
const router = express.Router();
const Trip = require('../models/Trip');
const Route = require('../models/Route');
const { generateMapImages, generateMapImagesForPoint, copyMapImages, deleteMapImages } = require('../services/mapImage');

// GET /api/trips - Get user's group rides (created + joined)
router.get('/', async (req, res) => {
  try {
    const userId = req.user.uid;
    
    // Get rides where user is creator OR attendee
    const trips = await Trip.find({
      $or: [
        { creatorId: userId },
        { attendeeIds: userId }
      ]
    })
    .sort({ dateTime: 1 })
    .lean();
    
    // Add computed fields for the client
    const enrichedTrips = trips.map(t => ({
      ...t,
      attendeeCount: t.attendeeIds?.length || 0,
      isCreator: t.creatorId === userId,
      isJoined: t.attendeeIds?.includes(userId) || false
    }));
    
    res.json(enrichedTrips);
  } catch (error) {
    console.error('Get trips error:', error);
    res.status(500).json({ error: 'Failed to get group rides' });
  }
});

// GET /api/trips/discover - Discover public upcoming group rides
router.get('/discover', async (req, res) => {
  try {
    const { lat, lng, radiusKm = 100, limit = 50 } = req.query;
    
    const now = Date.now();
    
    // Base query: public, upcoming, in the future
    let query = {
      isPublic: true,
      status: 'upcoming',
      dateTime: { $gte: now }
    };
    
    let trips;
    
    if (lat && lng) {
      // Geo query if location provided
      trips = await Trip.aggregate([
        {
          $geoNear: {
            near: {
              type: 'Point',
              coordinates: [parseFloat(lng), parseFloat(lat)]
            },
            distanceField: 'distanceMeters',
            maxDistance: parseFloat(radiusKm) * 1000,
            spherical: true,
            query: query
          }
        },
        { $limit: parseInt(limit) },
        {
          $addFields: {
            distanceKm: { $divide: ['$distanceMeters', 1000] },
            attendeeCount: { $size: '$attendeeIds' }
          }
        }
      ]);
    } else {
      // No location - just get upcoming rides sorted by date
      trips = await Trip.find(query)
        .sort({ dateTime: 1 })
        .limit(parseInt(limit))
        .lean();
    }
    
    // Add computed fields for the client
    const userId = req.user.uid;
    trips = trips.map(t => ({
      ...t,
      attendeeCount: t.attendeeIds?.length || 0,
      isCreator: t.creatorId === userId,
      isJoined: t.attendeeIds?.includes(userId) || false
    }));
    
    res.json(trips);
  } catch (error) {
    console.error('Discover trips error:', error);
    res.status(500).json({ error: 'Failed to discover group rides' });
  }
});

// GET /api/trips/:id - Get single group ride details
router.get('/:id', async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).lean();
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }
    
    // Check if private and user not authorized
    if (!trip.isPublic && 
        trip.creatorId !== req.user.uid && 
        !trip.attendeeIds.includes(req.user.uid)) {
      return res.status(403).json({ error: 'This group ride is private' });
    }
    
    res.json({
      ...trip,
      attendeeCount: trip.attendeeIds?.length || 0,
      isCreator: trip.creatorId === req.user.uid,
      isJoined: trip.attendeeIds?.includes(req.user.uid) || false
    });
  } catch (error) {
    console.error('Get trip error:', error);
    res.status(500).json({ error: 'Failed to get group ride' });
  }
});

// POST /api/trips - Create a new group ride
router.post('/', async (req, res) => {
  try {
    const { 
      title, description, dateTime, 
      startLat, startLng, startAddress,
      endLat, endLng, endAddress,
      estimatedDuration, estimatedDistance, difficulty,
      linkedRouteId, maxRiders, isPublic,
      ridingStyles, extraInfo
    } = req.body;
    
    if (!title || !dateTime || !startLat || !startLng) {
      return res.status(400).json({ 
        error: 'title, dateTime, startLat, and startLng are required' 
      });
    }
    
    // Generate map images based on location type
    let mapImages = { mapImageLightUrl: '', mapImageDarkUrl: '' };
    let resolvedStartAddress = startAddress || '';
    let resolvedEndLat = endLat;
    let resolvedEndLng = endLng;
    let resolvedEndAddress = endAddress || '';
    
    if (linkedRouteId) {
      // Copy images from the linked route
      const linkedRoute = await Route.findById(linkedRouteId).lean();
      if (linkedRoute?.mapImageLightUrl) {
        mapImages = await copyMapImages(linkedRoute.mapImageLightUrl, linkedRoute.mapImageDarkUrl, 'groupride');
      } else if (linkedRoute?.encodedPolyline) {
        mapImages = await generateMapImages(linkedRoute.encodedPolyline, 'groupride', req.body.mapStyle || {});
      }
      // Inherit addresses from linked route if not provided
      if (!resolvedStartAddress && linkedRoute?.startAddress) {
        resolvedStartAddress = linkedRoute.startAddress;
      }
      // Inherit end location from linked route if not provided
      if (!resolvedEndLat && !resolvedEndLng && linkedRoute?.endLocation?.coordinates) {
        resolvedEndLat = linkedRoute.endLocation.coordinates[1];
        resolvedEndLng = linkedRoute.endLocation.coordinates[0];
      }
      if (!resolvedEndAddress && linkedRoute?.endAddress) {
        resolvedEndAddress = linkedRoute.endAddress;
      }
    }
    // If no route images, generate from start point
    if (!mapImages.mapImageLightUrl) {
      mapImages = await generateMapImagesForPoint(startLat, startLng, 'groupride');
    }
    
    const trip = new Trip({
      creatorId: req.user.uid,
      creatorName: req.user.name || 'Anonymous',
      creatorPhotoUrl: req.user.picture || '',
      title,
      description: description || '',
      dateTime,
      startLocation: {
        type: 'Point',
        coordinates: [startLng, startLat]
      },
      startAddress: resolvedStartAddress,
      endLocation: resolvedEndLat && resolvedEndLng ? {
        type: 'Point',
        coordinates: [resolvedEndLng, resolvedEndLat]
      } : undefined,
      endAddress: resolvedEndAddress,
      estimatedDuration: estimatedDuration || 0,
      estimatedDistance: estimatedDistance || 0,
      difficulty: difficulty || 'moderate',
      linkedRouteId: linkedRouteId || null,
      ridingStyles: ridingStyles || [],
      extraInfo: extraInfo || '',
      maxRiders: maxRiders || 0,
      isPublic: isPublic !== false, // Default true
      attendeeIds: [req.user.uid], // Creator auto-joins
      status: 'upcoming',
      mapImageLightUrl: mapImages.mapImageLightUrl,
      mapImageDarkUrl: mapImages.mapImageDarkUrl
    });
    
    await trip.save();
    res.status(201).json(trip);
  } catch (error) {
    console.error('Create trip error:', error);
    res.status(500).json({ error: 'Failed to create group ride' });
  }
});

// PUT /api/trips/:id - Update a group ride (creator only)
router.put('/:id', async (req, res) => {
  try {
    const trip = await Trip.findOne({
      _id: req.params.id,
      creatorId: req.user.uid
    });
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found or not authorized' });
    }
    
    // Only allow updates if still upcoming
    if (trip.status !== 'upcoming') {
      return res.status(400).json({ error: 'Can only edit upcoming group rides' });
    }
    
    // Check if linkedRouteId or location changed — regenerate images
    const routeChanged = req.body.linkedRouteId !== undefined && req.body.linkedRouteId !== (trip.linkedRouteId?.toString() || null);
    const locationChanged = req.body.startLat && req.body.startLng && 
      (req.body.startLat !== trip.startLocation.coordinates[1] || 
       req.body.startLng !== trip.startLocation.coordinates[0]);
    
    if (routeChanged || locationChanged) {
      // Delete old images
      deleteMapImages(trip.mapImageLightUrl, trip.mapImageDarkUrl).catch(() => {});
      
      // Generate new images
      let mapImages = { mapImageLightUrl: '', mapImageDarkUrl: '' };
      const newRouteId = req.body.linkedRouteId;
      if (newRouteId) {
        const linkedRoute = await Route.findById(newRouteId).lean();
        if (linkedRoute?.mapImageLightUrl) {
          mapImages = await copyMapImages(linkedRoute.mapImageLightUrl, linkedRoute.mapImageDarkUrl, 'groupride');
        } else if (linkedRoute?.encodedPolyline) {
          mapImages = await generateMapImages(linkedRoute.encodedPolyline, 'groupride', req.body.mapStyle || {});
        }
        // Inherit end location from linked route if not provided
        if (!req.body.endLat && !req.body.endLng && linkedRoute?.endLocation?.coordinates) {
          trip.endLocation = linkedRoute.endLocation;
        }
        if (!req.body.endAddress && linkedRoute?.endAddress) {
          trip.endAddress = linkedRoute.endAddress;
        }
        if (!req.body.startAddress && linkedRoute?.startAddress) {
          trip.startAddress = linkedRoute.startAddress;
        }
      }
      if (!mapImages.mapImageLightUrl) {
        const lat = req.body.startLat || trip.startLocation.coordinates[1];
        const lng = req.body.startLng || trip.startLocation.coordinates[0];
        mapImages = await generateMapImagesForPoint(lat, lng, 'groupride');
      }
      trip.mapImageLightUrl = mapImages.mapImageLightUrl;
      trip.mapImageDarkUrl = mapImages.mapImageDarkUrl;
    }
    
    // Updatable fields
    const updateFields = [
      'title', 'description', 'dateTime', 'startAddress', 'endAddress',
      'estimatedDuration', 'estimatedDistance', 'difficulty',
      'linkedRouteId', 'ridingStyles', 'extraInfo',
      'maxRiders', 'isPublic'
    ];
    
    updateFields.forEach(field => {
      if (req.body[field] !== undefined) {
        trip[field] = req.body[field];
      }
    });
    
    // Update start location if provided
    if (req.body.startLat && req.body.startLng) {
      trip.startLocation = {
        type: 'Point',
        coordinates: [req.body.startLng, req.body.startLat]
      };
    }
    
    // Update end location if provided
    if (req.body.endLat && req.body.endLng) {
      trip.endLocation = {
        type: 'Point',
        coordinates: [req.body.endLng, req.body.endLat]
      };
    }
    
    await trip.save();
    res.json(trip);
  } catch (error) {
    console.error('Update trip error:', error);
    res.status(500).json({ error: 'Failed to update group ride' });
  }
});

// POST /api/trips/:id/join - Join a group ride
router.post('/:id/join', async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }
    
    if (!trip.isPublic && trip.creatorId !== req.user.uid) {
      return res.status(403).json({ error: 'This group ride is private' });
    }
    
    if (trip.status !== 'upcoming') {
      return res.status(400).json({ error: 'Can only join upcoming group rides' });
    }
    
    if (trip.attendeeIds.includes(req.user.uid)) {
      return res.status(400).json({ error: 'Already joined this group ride' });
    }
    
    if (trip.maxRiders > 0 && trip.attendeeIds.length >= trip.maxRiders) {
      return res.status(400).json({ error: 'Group ride is full' });
    }
    
    trip.attendeeIds.push(req.user.uid);
    await trip.save();
    
    res.json({ 
      message: 'Joined group ride', 
      attendeeCount: trip.attendeeIds.length 
    });
  } catch (error) {
    console.error('Join trip error:', error);
    res.status(500).json({ error: 'Failed to join group ride' });
  }
});

// POST /api/trips/:id/leave - Leave a group ride
router.post('/:id/leave', async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }
    
    if (trip.creatorId === req.user.uid) {
      return res.status(400).json({ 
        error: 'Creator cannot leave. Cancel the group ride instead.' 
      });
    }
    
    const idx = trip.attendeeIds.indexOf(req.user.uid);
    if (idx === -1) {
      return res.status(400).json({ error: 'Not a participant of this group ride' });
    }
    
    trip.attendeeIds.splice(idx, 1);
    await trip.save();
    
    res.json({ 
      message: 'Left group ride', 
      attendeeCount: trip.attendeeIds.length 
    });
  } catch (error) {
    console.error('Leave trip error:', error);
    res.status(500).json({ error: 'Failed to leave group ride' });
  }
});

// POST /api/trips/:id/start - Start a group ride (creator only)
router.post('/:id/start', async (req, res) => {
  try {
    const trip = await Trip.findOne({
      _id: req.params.id,
      creatorId: req.user.uid
    });
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found or not authorized' });
    }
    
    if (trip.status !== 'upcoming') {
      return res.status(400).json({ error: 'Group ride already started or completed' });
    }
    
    trip.status = 'ongoing';
    trip.actualStartTime = Date.now();
    await trip.save();
    
    res.json({ message: 'Group ride started', trip });
  } catch (error) {
    console.error('Start trip error:', error);
    res.status(500).json({ error: 'Failed to start group ride' });
  }
});

// POST /api/trips/:id/complete - Complete a group ride (creator only)
router.post('/:id/complete', async (req, res) => {
  try {
    const trip = await Trip.findOne({
      _id: req.params.id,
      creatorId: req.user.uid
    });
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found or not authorized' });
    }
    
    if (trip.status !== 'ongoing') {
      return res.status(400).json({ error: 'Group ride must be ongoing to complete' });
    }
    
    trip.status = 'completed';
    trip.actualEndTime = Date.now();
    trip.totalParticipants = trip.attendeeIds.length;
    await trip.save();
    
    res.json({ message: 'Group ride completed', trip });
  } catch (error) {
    console.error('Complete trip error:', error);
    res.status(500).json({ error: 'Failed to complete group ride' });
  }
});

// POST /api/trips/:id/cancel - Cancel a group ride (creator only)
router.post('/:id/cancel', async (req, res) => {
  try {
    const trip = await Trip.findOne({
      _id: req.params.id,
      creatorId: req.user.uid
    });
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found or not authorized' });
    }
    
    if (trip.status === 'completed') {
      return res.status(400).json({ error: 'Cannot cancel a completed group ride' });
    }
    
    trip.status = 'cancelled';
    await trip.save();
    
    res.json({ message: 'Group ride cancelled' });
  } catch (error) {
    console.error('Cancel trip error:', error);
    res.status(500).json({ error: 'Failed to cancel group ride' });
  }
});

// POST /api/trips/:id/link-ride - Link a completed ride to this group ride
router.post('/:id/link-ride', async (req, res) => {
  try {
    const { rideId } = req.body;
    
    if (!rideId) {
      return res.status(400).json({ error: 'rideId is required' });
    }
    
    const trip = await Trip.findById(req.params.id);
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }
    
    // User must be a participant
    if (!trip.attendeeIds.includes(req.user.uid)) {
      return res.status(403).json({ error: 'Not a participant of this group ride' });
    }
    
    // Add the ride ID if not already linked
    if (!trip.completedRideIds.includes(rideId)) {
      trip.completedRideIds.push(rideId);
      await trip.save();
    }
    
    res.json({ message: 'Ride linked to group ride' });
  } catch (error) {
    console.error('Link ride error:', error);
    res.status(500).json({ error: 'Failed to link ride' });
  }
});

// DELETE /api/trips/:id - Delete a group ride (creator only, upcoming only)
router.delete('/:id', async (req, res) => {
  try {
    const result = await Trip.findOneAndDelete({
      _id: req.params.id,
      creatorId: req.user.uid,
      status: 'upcoming' // Can only delete upcoming rides
    });
    
    if (!result) {
      return res.status(404).json({ 
        error: 'Group ride not found, not authorized, or already started' 
      });
    }
    
    // Delete map images from Firebase Storage
    deleteMapImages(result.mapImageLightUrl, result.mapImageDarkUrl).catch(() => {});
    
    res.json({ message: 'Group ride deleted' });
  } catch (error) {
    console.error('Delete trip error:', error);
    res.status(500).json({ error: 'Failed to delete group ride' });
  }
});

module.exports = router;
