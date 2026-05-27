// Phase 3 — Live Share REST surface.
//   POST /api/live/solo/link            self; returns viewer JWT for ride:<uid> room
//   POST /api/live/group/:tripId/link   group ride attendee; returns viewer JWT URL
//   GET  /api/live/active               sessions the caller is allowed to watch

const express = require('express');
const router = express.Router();
const Trip = require('../models/Trip');
const {
  signViewerJwt,
  listActiveForViewer,
  userIsInOwnerCircle,
  userIsAttendee
} = require('../socket/liveShare');

const BASE_URL = process.env.LIVE_SHARE_BASE_URL || 'https://apexride.dev';

// POST /api/live/solo/link — caller signs a viewer token for their own live room.
router.post('/solo/link', async (req, res) => {
  try {
    const uid = req.user.uid;
    const token = signViewerJwt({ rideId: uid }, 15 * 60);
    res.json({
      token,
      url: `${BASE_URL}/live/${token}`,
      expiresInSec: 15 * 60
    });
  } catch (e) {
    console.error('live solo link error', e);
    res.status(500).json({ error: 'Failed to create live link' });
  }
});

// POST /api/live/group/:tripId/link
router.post('/group/:tripId/link', async (req, res) => {
  try {
    const { tripId } = req.params;
    const ok = await userIsAttendee(req.user.uid, tripId);
    if (!ok) return res.status(403).json({ error: 'Not an attendee' });
    const token = signViewerJwt({ groupRideId: tripId }, 15 * 60);
    res.json({
      token,
      url: `${BASE_URL}/live/${token}`,
      expiresInSec: 15 * 60
    });
  } catch (e) {
    console.error('live group link error', e);
    res.status(500).json({ error: 'Failed to create live link' });
  }
});

// GET /api/live/active — list live sessions caller can watch.
router.get('/active', async (req, res) => {
  try {
    const all = listActiveForViewer(req.user.uid);
    const visible = [];
    for (const s of all) {
      let allowed = false;
      if (s.kind === 'ride') {
        allowed = await userIsInOwnerCircle(req.user.uid, s.ownerId);
      } else if (s.kind === 'groupride') {
        allowed = await userIsAttendee(req.user.uid, s.id);
      }
      if (allowed) visible.push(s);
    }
    res.json({ items: visible });
  } catch (e) {
    console.error('live active error', e);
    res.status(500).json({ error: 'Failed to list active sessions' });
  }
});

module.exports = router;
