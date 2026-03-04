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
