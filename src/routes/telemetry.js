const express = require('express');
const router = express.Router();
const Telemetry = require('../models/Telemetry');

// GET /api/telemetry/:rideId — Lazy-load telemetry for a single ride
router.get('/:rideId', async (req, res) => {
  try {
    const telemetry = await Telemetry.findOne({
      rideId: req.params.rideId,
      userId: req.user.uid
    }).lean();

    if (!telemetry) {
      return res.status(404).json({ error: 'Telemetry not found' });
    }

    res.json({
      speed: telemetry.speed,
      gForce: telemetry.gForce,
      leanAngle: telemetry.leanAngle,
      timestamp: telemetry.timestamp,
      cumDistanceM: telemetry.cumDistanceM
    });
  } catch (error) {
    console.error('Get telemetry error:', error);
    res.status(500).json({ error: 'Failed to get telemetry' });
  }
});

// GET /api/telemetry/group/:groupRideId — All riders' telemetry for a group ride
router.get('/group/:groupRideId', async (req, res) => {
  try {
    const telemetries = await Telemetry.find({
      groupRideId: req.params.groupRideId
    }).lean();

    res.json(telemetries.map(t => ({
      userId: t.userId,
      rideId: t.rideId,
      speed: t.speed,
      gForce: t.gForce,
      leanAngle: t.leanAngle,
      timestamp: t.timestamp,
      cumDistanceM: t.cumDistanceM
    })));
  } catch (error) {
    console.error('Get group telemetry error:', error);
    res.status(500).json({ error: 'Failed to get group telemetry' });
  }
});

module.exports = router;
