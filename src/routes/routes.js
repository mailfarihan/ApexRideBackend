const express = require('express');
const router = express.Router();
const Route = require('../models/Route');

// GET /api/routes - Get public routes with optional geo filter
router.get('/', async (req, res) => {
  try {
    const { lat, lng, radiusKm, sortBy, limit = 50 } = req.query;
    
    let query = { isPublic: true };
    
    // If location provided, filter routes where start OR end is within radius
    if (lat && lng) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);
      const radiusInRadians = (parseFloat(radiusKm) || 50) / 6378.1; // Earth radius in km
      
      // Use $geoWithin with $centerSphere to find routes where
      // EITHER start OR end location is within the specified radius
      query.$or = [
        {
          startLocation: {
            $geoWithin: {
              $centerSphere: [[longitude, latitude], radiusInRadians]
            }
          }
        },
        {
          endLocation: {
            $geoWithin: {
              $centerSphere: [[longitude, latitude], radiusInRadians]
            }
          }
        }
      ];
    }
    
    // Sort options
    let sort = { createdAt: -1 };
    if (sortBy === 'scenic') sort = { scenicScore: -1 };
    if (sortBy === 'rating') sort = { ratingAvg: -1 };
    if (sortBy === 'distance' && lat && lng) {
      // For distance sort, we need to calculate distance manually
      // Using aggregation with $geoNear won't work with $or
      // So we'll add distance calculation in aggregation
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);
      
      const routes = await Route.aggregate([
        { $match: query },
        {
          $addFields: {
            // Calculate distance to start point (in meters)
            distanceToStart: {
              $multiply: [
                6378100, // Earth radius in meters
                {
                  $acos: {
                    $add: [
                      {
                        $multiply: [
                          { $sin: { $degreesToRadians: latitude } },
                          { $sin: { $degreesToRadians: { $arrayElemAt: ['$startLocation.coordinates', 1] } } }
                        ]
                      },
                      {
                        $multiply: [
                          { $cos: { $degreesToRadians: latitude } },
                          { $cos: { $degreesToRadians: { $arrayElemAt: ['$startLocation.coordinates', 1] } } },
                          { $cos: { $subtract: [
                            { $degreesToRadians: { $arrayElemAt: ['$startLocation.coordinates', 0] } },
                            { $degreesToRadians: longitude }
                          ]}}
                        ]
                      }
                    ]
                  }
                }
              ]
            }
          }
        },
        { $sort: { distanceToStart: 1 } },
        { $limit: parseInt(limit) }
      ]);
      
      return res.json(routes);
    }
    
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
