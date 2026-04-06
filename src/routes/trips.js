const express = require('express');
const router = express.Router();
const Trip = require('../models/Trip');
const Ride = require('../models/Ride');
const Telemetry = require('../models/Telemetry');
const Route = require('../models/Route');
const User = require('../models/User');
const { generateMapImages, generateMapImagesForPoint, copyMapImages, deleteMapImages, generateMapImagesMultiPath } = require('../services/mapImage');

// In-memory store for member location pings (ephemeral, no need to persist)
// Key: tripId, Value: Map<userId, { lat, lng, timestamp, displayName }>
const memberPings = new Map();
const PING_EXPIRY_MS = 90_000; // pings older than 90s are stale
const NEARBY_RADIUS_M = 500;

// ─── Auto-complete infrastructure ───
// Auto-completion relies solely on a periodic stale sweep that checks
// whether the most recent linked ride ended more than 3 h ago.
// This lets groups do multiple ride sessions with breaks in between;
// the creator can always complete manually at any time.
const STALE_IDLE_MS = 3 * 60 * 60 * 1000; // 3 hours of no new ride activity

/**
 * Execute the completion: set status, compute summary, regenerate map image.
 * Mirrors the manual POST /:id/complete logic.
 */
async function executeAutoComplete(tripId) {
  const trip = await Trip.findById(tripId);
  if (!trip || trip.status !== 'ongoing') return;

  const linkedRides = await Ride.find({
    $or: [
      { _id: { $in: trip.completedRideIds || [] } },
      { groupRideId: tripId }
    ]
  }).select('distance duration avgSpeed encodedPolyline userId').lean();

  trip.status = 'completed';
  trip.actualEndTime = Date.now();
  trip.totalParticipants = new Set(linkedRides.map(r => r.userId)).size;

  if (linkedRides.length > 0) {
    const totalDistance = linkedRides.reduce((s, r) => s + (r.distance || 0), 0);
    const totalDuration = linkedRides.reduce((s, r) => s + (r.duration || 0), 0);
    const totalSpeed = linkedRides.reduce((s, r) => s + (r.avgSpeed || 0), 0);
    trip.summaryAvgDistance = totalDistance / linkedRides.length;
    trip.summaryAvgSpeed = totalSpeed / linkedRides.length;
    trip.summaryAvgDuration = totalDuration / linkedRides.length;
  }

  await trip.save();

  // Clean up pings
  memberPings.delete(tripId);

  // Regenerate map with all member routes (async, non-blocking)
  const polylines = linkedRides
    .map(r => r.encodedPolyline)
    .filter(p => p && p.length > 0);
  if (polylines.length > 0) {
    generateMapImagesMultiPath(polylines, 'groupride_actual')
      .then(async ({ mapImageLightUrl, mapImageDarkUrl }) => {
        if (mapImageLightUrl || mapImageDarkUrl) {
          const oldLight = trip.mapImageLightUrl;
          const oldDark = trip.mapImageDarkUrl;
          await Trip.findByIdAndUpdate(tripId, { mapImageLightUrl, mapImageDarkUrl });
          deleteMapImages(oldLight, oldDark).catch(() => {});
        }
      })
      .catch(err => console.error('Auto-complete map regen error:', err.message));
  }

  console.log(`Auto-completed group ride ${tripId} with ${linkedRides.length} linked rides from ${trip.totalParticipants} riders`);
}

// ─── Periodic stale-ongoing sweep ───
// Runs every 30 min.  For each ongoing trip that has ≥1 linked ride,
// check the most-recent ride endTime.  If that ride ended >3 h ago
// (meaning no new riding activity), auto-complete the group ride.
// Also catches trips that started >6 h ago with no rides at all.
setInterval(async () => {
  try {
    const ongoingTrips = await Trip.find({ status: 'ongoing' })
      .select('_id completedRideIds actualStartTime dateTime')
      .lean();

    for (const t of ongoingTrips) {
      const linkedRides = await Ride.find({
        $or: [
          { _id: { $in: t.completedRideIds || [] } },
          { groupRideId: t._id }
        ]
      }).select('endTime').lean();

      if (linkedRides.length > 0) {
        // Use the most recent ride endTime to decide staleness
        const lastEnd = Math.max(...linkedRides.map(r => r.endTime || 0));
        if (lastEnd > 0 && Date.now() - lastEnd >= STALE_IDLE_MS) {
          await executeAutoComplete(t._id.toString());
        }
      } else {
        // No rides linked at all — complete if started >6 h ago (abandoned)
        const startedAt = t.actualStartTime || t.dateTime || 0;
        if (startedAt > 0 && Date.now() - startedAt >= STALE_IDLE_MS * 2) {
          // No rides to summarise — just mark completed
          await Trip.findByIdAndUpdate(t._id, {
            status: 'completed',
            actualEndTime: Date.now(),
            totalParticipants: 0
          });
          console.log(`Stale sweep: completed abandoned group ride ${t._id}`);
        }
      }
    }
  } catch (err) {
    console.error('Stale ongoing sweep error:', err.message);
  }
}, 30 * 60 * 1000);

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

// GET /api/trips/discover - Discover public upcoming/ongoing group rides
router.get('/discover', async (req, res) => {
  try {
    const { lat, lng, radiusKm = 100, limit = 50 } = req.query;
    
    // Show public rides that are upcoming or ongoing (hide completed/cancelled)
    // For upcoming rides, exclude those whose dateTime is more than 1 hour in the past (expired)
    const oneHourAgo = Date.now() - 3600000;
    let query = {
      isPublic: true,
      $or: [
        { status: 'ongoing' },
        { status: 'upcoming', dateTime: { $gte: oneHourAgo } }
      ]
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
            key: 'startLocation',
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
      // No location - just get upcoming/ongoing rides sorted by date
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
      estimatedDuration, estimatedDistance,
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
      'estimatedDuration', 'estimatedDistance',
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
    const tripObj = trip.toObject();
    tripObj.isCreator = true;
    tripObj.isJoined = true;
    res.json(tripObj);
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
// POST /api/trips/:id/ping - Member sends their location (lightweight heartbeat)
router.post('/:id/ping', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (lat == null || lng == null) {
      return res.status(400).json({ error: 'lat and lng required' });
    }

    const tripId = req.params.id;
    const userId = req.user.uid;

    // Verify user is an attendee
    const trip = await Trip.findById(tripId).select('attendeeIds status dateTime startLocation').lean();
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }
    if (!trip.attendeeIds.includes(userId) && trip.creatorId !== userId) {
      return res.status(403).json({ error: 'Not a member of this group ride' });
    }

    // Store ping
    if (!memberPings.has(tripId)) {
      memberPings.set(tripId, new Map());
    }

    // Compute speed from consecutive pings (m/s) — used to filter out riders in motion
    const prevPing = memberPings.get(tripId).get(userId);
    let speedMps = 0;
    if (prevPing) {
      const dt = (Date.now() - prevPing.timestamp) / 1000; // seconds
      if (dt > 0 && dt < PING_EXPIRY_MS / 1000) {
        const dist = haversineDistance(prevPing.lat, prevPing.lng, parseFloat(lat), parseFloat(lng));
        speedMps = dist / dt;
      }
    }

    memberPings.get(tripId).set(userId, {
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      timestamp: Date.now(),
      displayName: req.user.name || '',
      speedMps
    });

    // Auto-trigger: if UPCOMING, within time window, enough STATIONARY nearby members → start
    // "Stationary" means speed < 5 m/s (~18 km/h) — filters out riders passing through
    //
    // Two-tier check:
    //   PRIMARY:  ≥2 stationary members within 500m of startLocation
    //   FALLBACK: ≥2 stationary members within 500m of each other (any location)
    const STATIONARY_SPEED_MPS = 5;
    let autoStarted = false;
    if (trip.status === 'upcoming') {
      const now = Date.now();
      const timeToRide = trip.dateTime - now;
      const TIME_BEFORE = 30 * 60 * 1000;
      const TIME_AFTER = 60 * 60 * 1000;

      if (timeToRide >= -TIME_AFTER && timeToRide <= TIME_BEFORE) {
        const pings = memberPings.get(tripId);

        // Collect fresh, stationary pings
        const fresh = [];
        if (pings && pings.size >= 2) {
          for (const [uid, ping] of pings) {
            if (Date.now() - ping.timestamp <= PING_EXPIRY_MS && ping.speedMps < STATIONARY_SPEED_MPS) {
              fresh.push({ uid, lat: ping.lat, lng: ping.lng });
            }
          }
        }

        let shouldStart = false;

        // PRIMARY: ≥2 stationary members near startLocation
        const startLat = trip.startLocation?.coordinates?.[1];
        const startLng = trip.startLocation?.coordinates?.[0];
        if (startLat != null && startLng != null) {
          let nearStartCount = 0;
          for (const p of fresh) {
            if (haversineDistance(p.lat, p.lng, startLat, startLng) <= NEARBY_RADIUS_M) {
              nearStartCount++;
            }
          }
          if (nearStartCount >= 2) shouldStart = true;
        }

        // FALLBACK: ≥2 stationary members near each other (any location)
        if (!shouldStart && fresh.length >= 2) {
          const nearbySet = new Set();
          for (let i = 0; i < fresh.length; i++) {
            for (let j = i + 1; j < fresh.length; j++) {
              const dist = haversineDistance(
                fresh[i].lat, fresh[i].lng,
                fresh[j].lat, fresh[j].lng
              );
              if (dist <= NEARBY_RADIUS_M) {
                nearbySet.add(fresh[i].uid);
                nearbySet.add(fresh[j].uid);
              }
            }
          }
          if (nearbySet.size >= 2) shouldStart = true;
        }

        if (shouldStart) {
          await Trip.findByIdAndUpdate(tripId, {
            status: 'ongoing',
            actualStartTime: Date.now()
          });
          autoStarted = true;
        }
      }
    }

    // Count members near THIS user's current position (for ongoing ride linkage)
    let nearbyUserCount = 0;
    const pingsForCount = memberPings.get(tripId);
    if (pingsForCount) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      for (const [uid, ping] of pingsForCount) {
        if (uid === userId) continue; // skip self
        if (Date.now() - ping.timestamp > PING_EXPIRY_MS) continue;
        const dist = haversineDistance(ping.lat, ping.lng, userLat, userLng);
        if (dist <= NEARBY_RADIUS_M) nearbyUserCount++;
      }
    }

    res.json({ ok: true, autoStarted, nearbyUserCount });
  } catch (error) {
    console.error('Ping error:', error);
    res.status(500).json({ error: 'Failed to process ping' });
  }
});

// GET /api/trips/:id/nearby - Get members with recent location pings near start
router.get('/:id/nearby', async (req, res) => {
  try {
    const tripId = req.params.id;

    const trip = await Trip.findById(tripId).select('attendeeIds startLocation creatorId').lean();
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }

    const pings = memberPings.get(tripId);
    if (!pings) {
      return res.json({ members: [], count: 0 });
    }

    const startLat = trip.startLocation?.coordinates?.[1];
    const startLng = trip.startLocation?.coordinates?.[0];
    const now = Date.now();
    const nearby = [];

    for (const [userId, ping] of pings) {
      if (now - ping.timestamp > PING_EXPIRY_MS) continue;
      if (startLat != null && startLng != null) {
        const dist = haversineDistance(ping.lat, ping.lng, startLat, startLng);
        if (dist <= NEARBY_RADIUS_M) {
          nearby.push({
            userId,
            displayName: ping.displayName,
            distanceM: Math.round(dist),
            lastPing: ping.timestamp
          });
        }
      }
    }

    res.json({ members: nearby, count: nearby.length });
  } catch (error) {
    console.error('Nearby error:', error);
    res.status(500).json({ error: 'Failed to get nearby members' });
  }
});

// POST /api/trips/:id/start - Start a group ride (creator OR auto-trigger by any attendee)
router.post('/:id/start', async (req, res) => {
  try {
    const userId = req.user.uid;
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }

    // Must be creator or attendee
    if (trip.creatorId !== userId && !trip.attendeeIds.includes(userId)) {
      return res.status(403).json({ error: 'Not authorized' });
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
    
    // Compute ride summary from linked rides
    const linkedRides = await Ride.find({
      $or: [
        { _id: { $in: trip.completedRideIds || [] } },
        { groupRideId: trip._id }
      ]
    }).select('distance duration avgSpeed encodedPolyline').lean();
    
    if (linkedRides.length > 0) {
      const totalDistance = linkedRides.reduce((sum, r) => sum + (r.distance || 0), 0);
      const totalDuration = linkedRides.reduce((sum, r) => sum + (r.duration || 0), 0);
      const totalSpeed = linkedRides.reduce((sum, r) => sum + (r.avgSpeed || 0), 0);
      trip.summaryAvgDistance = totalDistance / linkedRides.length;
      trip.summaryAvgSpeed = totalSpeed / linkedRides.length;
      trip.summaryAvgDuration = totalDuration / linkedRides.length;
    }
    
    await trip.save();
    
    res.json({ message: 'Group ride completed', trip });
    
    // Regenerate map images from actual ride polylines (async, non-blocking)
    const polylines = linkedRides
      .map(r => r.encodedPolyline)
      .filter(p => p && p.length > 0);
    if (polylines.length > 0) {
      generateMapImagesMultiPath(polylines, 'groupride_actual')
        .then(async ({ mapImageLightUrl, mapImageDarkUrl }) => {
          if (mapImageLightUrl || mapImageDarkUrl) {
            const oldLight = trip.mapImageLightUrl;
            const oldDark = trip.mapImageDarkUrl;
            await Trip.findByIdAndUpdate(trip._id, { mapImageLightUrl, mapImageDarkUrl });
            deleteMapImages(oldLight, oldDark).catch(() => {});
          }
        })
        .catch(err => console.error('Failed to regenerate group ride map:', err.message));
    }
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
      
      // Recompute ride summary
      const linkedRides = await Ride.find({
        $or: [
          { _id: { $in: trip.completedRideIds } },
          { groupRideId: trip._id }
        ]
      }).select('distance duration avgSpeed').lean();
      
      if (linkedRides.length > 0) {
        const totalDistance = linkedRides.reduce((sum, r) => sum + (r.distance || 0), 0);
        const totalDuration = linkedRides.reduce((sum, r) => sum + (r.duration || 0), 0);
        const totalSpeed = linkedRides.reduce((sum, r) => sum + (r.avgSpeed || 0), 0);
        trip.summaryAvgDistance = totalDistance / linkedRides.length;
        trip.summaryAvgSpeed = totalSpeed / linkedRides.length;
        trip.summaryAvgDuration = totalDuration / linkedRides.length;
      }
      
      await trip.save();
    }
    
    // Also update the ride document with groupRideId
    await Ride.findByIdAndUpdate(rideId, { groupRideId: trip._id });
    
    // Also update telemetry with groupRideId
    await Telemetry.findOneAndUpdate(
      { rideId: rideId },
      { groupRideId: trip._id }
    );
    
    res.json({ message: 'Ride linked to group ride' });
  } catch (error) {
    console.error('Link ride error:', error);
    res.status(500).json({ error: 'Failed to link ride' });
  }
});

// GET /api/trips/:id/detail - Pipeline API: group ride detail with all member rides & telemetry
router.get('/:id/detail', async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).lean();
    
    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }
    
    // Check access: must be participant or public
    if (!trip.isPublic && 
        trip.creatorId !== req.user.uid && 
        !trip.attendeeIds.includes(req.user.uid)) {
      return res.status(403).json({ error: 'This group ride is private' });
    }
    
    // Fetch all member rides linked to this group ride
    // Strategy: use completedRideIds from trip + any rides with groupRideId set
    const rideQuery = {
      $or: [
        { _id: { $in: trip.completedRideIds || [] } },
        { groupRideId: trip._id }
      ]
    };
    
    const rides = await Ride.find(rideQuery)
      .select('userId distance duration avgSpeed maxSpeed maxLeanAngle maxGForce startTime endTime encodedPolyline mapImageLightUrl mapImageDarkUrl startAddress endAddress')
      .lean();
    
    // Fetch all telemetry for these rides in one query
    const rideIds = rides.map(r => r._id);
    const telemetries = await Telemetry.find({
      $or: [
        { rideId: { $in: rideIds } },
        { groupRideId: trip._id }
      ]
    }).lean();
    
    // Look up participant display names
    const allUserIds = [...new Set([
      ...(trip.attendeeIds || []),
      ...rides.map(r => r.userId)
    ])];
    const users = await User.find(
      { firebaseUid: { $in: allUserIds } },
      { firebaseUid: 1, displayName: 1, photoUrl: 1 }
    ).lean();
    const userNameMap = {};
    const userPhotoMap = {};
    users.forEach(u => { 
      userNameMap[u.firebaseUid] = u.displayName || 'Rider';
      userPhotoMap[u.firebaseUid] = u.photoUrl || '';
    });

    // Build response
    res.json({
      ...trip,
      attendeeCount: trip.attendeeIds?.length || 0,
      isCreator: trip.creatorId === req.user.uid,
      isJoined: trip.attendeeIds?.includes(req.user.uid) || false,
      participants: allUserIds.map(uid => ({
        userId: uid,
        displayName: userNameMap[uid] || 'Rider',
        photoUrl: userPhotoMap[uid] || ''
      })),
      rides: rides.map(r => ({
        _id: r._id,
        userId: r.userId,
        displayName: userNameMap[r.userId] || 'Rider',
        distance: r.distance || 0,
        duration: r.duration || 0,
        avgSpeed: r.avgSpeed || 0,
        maxSpeed: r.maxSpeed || 0,
        maxLeanAngle: r.maxLeanAngle || 0,
        maxGForce: r.maxGForce || 0,
        startTime: r.startTime,
        endTime: r.endTime,
        encodedPolyline: r.encodedPolyline || '',
        mapImageLightUrl: r.mapImageLightUrl || '',
        mapImageDarkUrl: r.mapImageDarkUrl || '',
        startAddress: r.startAddress || '',
        endAddress: r.endAddress || ''
      })),
      telemetry: telemetries.map(t => ({
        userId: t.userId,
        rideId: t.rideId,
        displayName: userNameMap[t.userId] || 'Rider',
        speed: t.speed,
        gForce: t.gForce,
        leanAngle: t.leanAngle,
        timestamp: t.timestamp,
        cumDistanceM: t.cumDistanceM
      }))
    });
  } catch (error) {
    console.error('Get group ride detail error:', error);
    res.status(500).json({ error: 'Failed to get group ride detail' });
  }
});

// DELETE /api/trips/:id - Delete a group ride (creator only, upcoming only)
router.delete('/:id', async (req, res) => {
  try {
    const result = await Trip.findOneAndDelete({
      _id: req.params.id,
      creatorId: req.user.uid,
      status: { $in: ['upcoming', 'completed', 'cancelled'] }
    });
    
    if (!result) {
      return res.status(404).json({ 
        error: 'Group ride not found, not authorized, or ride is currently ongoing' 
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
