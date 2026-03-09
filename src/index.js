require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// One-time admin backfill endpoint — protected by ADMIN_SECRET env var
// Remove this block after running once.
app.post('/admin/backfill-map-images', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({ status: 'started', message: 'Backfill running in background — check server logs' });

  (async () => {
    function encodeSignedValue(value) {
      let v = value < 0 ? ~(value << 1) : value << 1;
      let encoded = '';
      while (v >= 0x20) { encoded += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      encoded += String.fromCharCode(v + 63);
      return encoded;
    }
    function encodePolyline(points) {
      let encoded = '', prevLat = 0, prevLng = 0;
      for (const pt of points) {
        const lat = Math.round(pt.latitude * 1e5), lng = Math.round(pt.longitude * 1e5);
        encoded += encodeSignedValue(lat - prevLat) + encodeSignedValue(lng - prevLng);
        prevLat = lat; prevLng = lng;
      }
      return encoded;
    }
    function getPolylineForRide(ride) {
      if (ride.encodedPolyline && ride.encodedPolyline.length > 0) return ride.encodedPolyline;
      if (ride.routePointsJson && ride.routePointsJson !== '[]') {
        try {
          const pts = JSON.parse(ride.routePointsJson);
          if (Array.isArray(pts) && pts.length >= 2) return encodePolyline(pts);
        } catch (e) { /* skip */ }
      }
      return null;
    }

    const Ride = require('./models/Ride');
    const Route = require('./models/Route');
    const Trip = require('./models/Trip');
    const { generateMapImages, generateMapImagesForPoint } = require('./services/mapImage');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let ok = 0, skip = 0;

    console.log('[backfill] Starting...');

    const rides = await Ride.find({ $or: [{ mapImageLightUrl: { $exists: false } }, { mapImageLightUrl: '' }, { mapImageLightUrl: null }] }).lean();
    console.log(`[backfill] Rides: ${rides.length}`);
    for (const ride of rides) {
      const poly = getPolylineForRide(ride);
      if (!poly) { skip++; continue; }
      try {
        const { mapImageLightUrl, mapImageDarkUrl } = await generateMapImages(poly, 'ride');
        if (mapImageLightUrl) { await Ride.updateOne({ _id: ride._id }, { mapImageLightUrl, mapImageDarkUrl }); ok++; console.log(`[backfill] ✅ Ride ${ride._id}`); }
        else { skip++; }
      } catch (e) { skip++; console.error(`[backfill] ❌ Ride ${ride._id}: ${e.message}`); }
      await sleep(500);
    }

    const routes = await Route.find({ $or: [{ mapImageLightUrl: { $exists: false } }, { mapImageLightUrl: '' }, { mapImageLightUrl: null }] }).lean();
    console.log(`[backfill] Routes: ${routes.length}`);
    for (const route of routes) {
      const poly = route.encodedPolyline && route.encodedPolyline.length > 0 ? route.encodedPolyline : null;
      if (!poly) { skip++; continue; }
      try {
        const { mapImageLightUrl, mapImageDarkUrl } = await generateMapImages(poly, 'route');
        if (mapImageLightUrl) { await Route.updateOne({ _id: route._id }, { mapImageLightUrl, mapImageDarkUrl }); ok++; console.log(`[backfill] ✅ Route ${route._id}`); }
        else { skip++; }
      } catch (e) { skip++; console.error(`[backfill] ❌ Route ${route._id}: ${e.message}`); }
      await sleep(500);
    }

    const trips = await Trip.find({ $or: [{ mapImageLightUrl: { $exists: false } }, { mapImageLightUrl: '' }, { mapImageLightUrl: null }] }).lean();
    console.log(`[backfill] Trips: ${trips.length}`);
    for (const trip of trips) {
      const coords = trip.meetupLocation && trip.meetupLocation.coordinates;
      if (!coords || coords.length < 2) { skip++; continue; }
      const [lng, lat] = coords;
      try {
        const { mapImageLightUrl, mapImageDarkUrl } = await generateMapImagesForPoint(lat, lng, 'trip');
        if (mapImageLightUrl) { await Trip.updateOne({ _id: trip._id }, { mapImageLightUrl, mapImageDarkUrl }); ok++; console.log(`[backfill] ✅ Trip ${trip._id}`); }
        else { skip++; }
      } catch (e) { skip++; console.error(`[backfill] ❌ Trip ${trip._id}: ${e.message}`); }
      await sleep(500);
    }

    console.log(`[backfill] Done — ${ok} generated, ${skip} skipped`);
  })().catch(err => console.error('[backfill] Fatal:', err.message));
});

// Check required env vars
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is required');
  process.exit(1);
}

// Load routes after env check
const authMiddleware = require('./middleware/auth');

const routesRouter = require('./routes/routes');
const ridesRouter = require('./routes/rides');
const tripsRouter = require('./routes/trips');
const usersRouter = require('./routes/users');

// Auth routes (no middleware - used for sign-in sync)


// Protected routes
app.use('/api/routes', authMiddleware, routesRouter);
app.use('/api/rides', authMiddleware, ridesRouter);
app.use('/api/trips', authMiddleware, tripsRouter);
app.use('/api/users', authMiddleware, usersRouter);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Connect to MongoDB and start server
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB Atlas');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });
