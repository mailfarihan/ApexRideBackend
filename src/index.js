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
const telemetryRouter = require('./routes/telemetry');

// Auth routes (no middleware - used for sign-in sync)


// Public routes (no auth required)
const Trip = require('./models/Trip');
const User = require('./models/User');

// GET /api/trips/:id/invite — Public invite endpoint for share links
app.get('/api/trips/:id/invite', async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id)
      .select('title description startAddress dateTime status creatorId creatorName creatorPhotoUrl attendeeIds ridingStyles estimatedDistance linkedRouteId maxRiders mapImageDarkUrl extraInfo')
      .lean();

    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }

    // Fetch participant display names + photos
    const allUserIds = [trip.creatorId, ...(trip.attendeeIds || [])];
    const users = await User.find({ firebaseUid: { $in: allUserIds } })
      .select('firebaseUid displayName photoUrl')
      .lean();

    const userMap = {};
    for (const u of users) {
      userMap[u.firebaseUid] = { displayName: u.displayName || 'Rider', photoUrl: u.photoUrl || '' };
    }

    const participants = (trip.attendeeIds || []).map(uid => ({
      displayName: userMap[uid]?.displayName || 'Rider',
      photoUrl: userMap[uid]?.photoUrl || ''
    }));

    res.json({
      id: trip._id,
      title: trip.title,
      description: trip.description,
      startAddress: trip.startAddress,
      dateTime: trip.dateTime,
      status: trip.status,
      creatorName: trip.creatorName,
      creatorPhotoUrl: userMap[trip.creatorId]?.photoUrl || trip.creatorPhotoUrl || '',
      attendeeCount: (trip.attendeeIds || []).length,
      maxRiders: trip.maxRiders || 0,
      ridingStyles: trip.ridingStyles || [],
      estimatedDistance: trip.estimatedDistance,
      mapImageDarkUrl: trip.mapImageDarkUrl || '',
      extraInfo: trip.extraInfo || '',
      participants
    });
  } catch (error) {
    console.error('Invite endpoint error:', error);
    res.status(500).json({ error: 'Failed to load group ride' });
  }
});

// Protected routes
app.use('/api/routes', authMiddleware, routesRouter);
app.use('/api/rides', authMiddleware, ridesRouter);
app.use('/api/trips', authMiddleware, tripsRouter);
app.use('/api/users', authMiddleware, usersRouter);
app.use('/api/telemetry', authMiddleware, telemetryRouter);

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
