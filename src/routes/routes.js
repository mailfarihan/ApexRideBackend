const express = require('express');
const router = express.Router();
const Route = require('../models/Route');

// GET /api/routes - Get public routes with optional geo filter
router.get('/', async (req, res) => {
  try {
    const { lat, lng, radiusKm, sortBy, limit = 50 } = req.query;
    
    let query = { isPublic: true };
    let aggregation = [];
    
    // If location provided, use $geoNear
    if (lat && lng) {
      const radiusMeters = (parseFloat(radiusKm) || 50) * 1000;
      
      aggregation.push({
        $geoNear: {
          near: {
            type: 'Point',
            coordinates: [parseFloat(lng), parseFloat(lat)]
          },
          distanceField: 'distanceFromUser',
          maxDistance: radiusMeters,
          query: { isPublic: true },
          spherical: true
        }
      });
      
      // Sort options after geoNear
      if (sortBy === 'scenic') {
        aggregation.push({ $sort: { scenicScore: -1 } });
      } else if (sortBy === 'rating') {
        aggregation.push({ $sort: { ratingAvg: -1 } });
      }
      // Default: sorted by distance (geoNear default)
      
      aggregation.push({ $limit: parseInt(limit) });
      
      const routes = await Route.aggregate(aggregation);
      return res.json(routes);
    }
    
    // No location - simple query
    let sort = { createdAt: -1 };
    if (sortBy === 'scenic') sort = { scenicScore: -1 };
    if (sortBy === 'rating') sort = { ratingAvg: -1 };
    
    const routes = await Route.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .lean();
    
    res.json(routes);
  } catch (error) {
    console.error('Get routes error:', error);
    res.status(500).json({ error: 'Failed to get routes' });
  }
});

// GET /api/routes/my - Get current user's routes
router.get('/my', async (req, res) => {
  try {
    const routes = await Route.find({ creatorId: req.user.uid })
      .sort({ createdAt: -1 })
      .lean();
    
    res.json(routes);
  } catch (error) {
    console.error('Get my routes error:', error);
    res.status(500).json({ error: 'Failed to get routes' });
  }
});

// GET /api/routes/:id - Get single route
router.get('/:id', async (req, res) => {
  try {
    const route = await Route.findById(req.params.id).lean();
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    res.json(route);
  } catch (error) {
    console.error('Get route error:', error);
    res.status(500).json({ error: 'Failed to get route' });
  }
});

// POST /api/routes - Publish a route
router.post('/', async (req, res) => {
  try {
    const { 
      title, description, region, encodedPolyline,
      startLat, startLng, endLat, endLng,
      distance, duration, avgSpeed, maxSpeed, elevationGain,
      scenicScore, twistyScore, tags, sourceRideId
    } = req.body;
    
    const route = new Route({
      creatorId: req.user.uid,
      creatorName: req.user.name,
      creatorPhotoUrl: req.user.picture || '',
      sourceRideId: sourceRideId || null,
      title,
      description,
      region,
      encodedPolyline,
      startLocation: {
        type: 'Point',
        coordinates: [parseFloat(startLng), parseFloat(startLat)]
      },
      endLocation: endLat && endLng ? {
        type: 'Point',
        coordinates: [parseFloat(endLng), parseFloat(endLat)]
      } : undefined,
      distance,
      duration,
      avgSpeed,
      maxSpeed,
      elevationGain,
      scenicScore,
      twistyScore,
      tags
    });
    
    await route.save();
    res.status(201).json(route);
  } catch (error) {
    console.error('Publish route error:', error);
    res.status(500).json({ error: 'Failed to publish route' });
  }
});

// POST /api/routes/:id/rate - Rate a route
router.post('/:id/rate', async (req, res) => {
  try {
    const { rating } = req.body; // 1-5
    
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1-5' });
    }
    
    const route = await Route.findById(req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    
    // Update rating (simple average, could be improved with separate ratings collection)
    route.ratingSum += rating;
    route.ratingCount += 1;
    route.ratingAvg = route.ratingSum / route.ratingCount;
    
    await route.save();
    res.json({ ratingAvg: route.ratingAvg, ratingCount: route.ratingCount });
  } catch (error) {
    console.error('Rate route error:', error);
    res.status(500).json({ error: 'Failed to rate route' });
  }
});

// PATCH /api/routes/:id - Update own route
router.patch('/:id', async (req, res) => {
  try {
    const route = await Route.findById(req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    
    if (route.creatorId !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { title, description, isPublic, tags } = req.body;
    
    if (title !== undefined) route.title = title;
    if (description !== undefined) route.description = description;
    if (isPublic !== undefined) route.isPublic = isPublic;
    if (tags !== undefined) route.tags = tags;
    
    await route.save();
    res.json(route);
  } catch (error) {
    console.error('Update route error:', error);
    res.status(500).json({ error: 'Failed to update route' });
  }
});

// DELETE /api/routes/:id - Delete own route
router.delete('/:id', async (req, res) => {
  try {
    const route = await Route.findById(req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    
    if (route.creatorId !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await route.deleteOne();
    res.json({ message: 'Route deleted' });
  } catch (error) {
    console.error('Delete route error:', error);
    res.status(500).json({ error: 'Failed to delete route' });
  }
});

module.exports = router;
