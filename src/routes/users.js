const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const User = require('../models/User');
const Ride = require('../models/Ride');
const Trip = require('../models/Trip');
const Route = require('../models/Route');
const Telemetry = require('../models/Telemetry');
const { deleteFromFirebase } = require('../services/mapImage');

// GET /api/users/me - Get current user's profile
router.get('/me', async (req, res) => {
  try {
    let user = await User.findOne({ firebaseUid: req.user.uid });
    
    // Create user if doesn't exist
    if (!user) {
      // Fetch Firebase Auth profile to get Google photo URL
      let photoUrl = null;
      try {
        const firebaseUser = await admin.auth().getUser(req.user.uid);
        photoUrl = firebaseUser.photoURL || null;
      } catch (e) {
        // ignore - photo is optional
      }
      user = new User({
        firebaseUid: req.user.uid,
        displayName: req.user.name || 'Rider',
        email: req.user.email,
        photoUrl
      });
      await user.save();
    }
    
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// PUT /api/users/me - Update current user's profile
router.put('/me', async (req, res) => {
  try {
    const updates = {};
    const allowedFields = ['displayName', 'bio', 'photoUrl', 'motorcycle', 'preferences'];
    
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // If photoUrl is changing, delete the old one from Firebase Storage
    if (updates.photoUrl !== undefined) {
      const existingUser = await User.findOne({ firebaseUid: req.user.uid });
      const oldPhotoUrl = existingUser?.photoUrl || null;
      if (oldPhotoUrl && oldPhotoUrl !== updates.photoUrl) {
        deleteFromFirebase(oldPhotoUrl).catch(() => {});
      }
    }
    
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      { $set: updates },
      { new: true, upsert: true }
    );
    
    res.json(user);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// PUT /api/users/me/photo - Update profile photo URL
router.put('/me/photo', async (req, res) => {
  try {
    const { photoUrl } = req.body;
    
    if (photoUrl === undefined) {
      return res.status(400).json({ error: 'photoUrl is required' });
    }

    // Get old photo URL to delete from Storage
    const existingUser = await User.findOne({ firebaseUid: req.user.uid });
    const oldPhotoUrl = existingUser?.photoUrl || null;

    // If clearing custom photo, fall back to Google account photo
    let newPhotoUrl = photoUrl || null;
    if (!newPhotoUrl) {
      try {
        const firebaseUser = await admin.auth().getUser(req.user.uid);
        newPhotoUrl = firebaseUser.photoURL || null;
      } catch (e) {
        // ignore - will just clear the photo
      }
    }

    // Delete old profile image from Firebase Storage if it changed
    if (oldPhotoUrl && oldPhotoUrl !== newPhotoUrl) {
      deleteFromFirebase(oldPhotoUrl).catch(() => {});
    }
    
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      { $set: { photoUrl: newPhotoUrl } },
      { new: true, upsert: true }
    );
    
    res.json({ photoUrl: user.photoUrl });
  } catch (error) {
    console.error('Update photo error:', error);
    res.status(500).json({ error: 'Failed to update photo' });
  }
});

// GET /api/users/:uid - Get another user's public profile
router.get('/:uid', async (req, res) => {
  try {
    const user = await User.findOne(
      { firebaseUid: req.params.uid },
      { email: 0, preferences: 0 } // Exclude private fields
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /api/users/:uid/follow - Follow a user
router.post('/:uid/follow', async (req, res) => {
  try {
    if (req.params.uid === req.user.uid) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }
    
    // Add to current user's following
    await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      { $addToSet: { following: req.params.uid } },
      { upsert: true }
    );
    
    // Add to target user's followers
    await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { $addToSet: { followers: req.user.uid } },
      { upsert: true }
    );
    
    res.json({ message: 'Followed user' });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

// POST /api/users/:uid/unfollow - Unfollow a user
router.post('/:uid/unfollow', async (req, res) => {
  try {
    // Remove from current user's following
    await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      { $pull: { following: req.params.uid } }
    );
    
    // Remove from target user's followers
    await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { $pull: { followers: req.user.uid } }
    );
    
    res.json({ message: 'Unfollowed user' });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
});

// DELETE /api/users/me - Permanently delete account and all associated data
router.delete('/me', async (req, res) => {
  try {
    const uid = req.user.uid;

    // 1. Delete user's profile photo from Firebase Storage
    const user = await User.findOne({ firebaseUid: uid });
    if (user?.photoUrl) {
      deleteFromFirebase(user.photoUrl).catch(() => {});
    }

    // 2. Delete all ride map images from Firebase Storage
    const rides = await Ride.find({ userId: uid }, { mapImageLightUrl: 1, mapImageDarkUrl: 1 });
    for (const ride of rides) {
      if (ride.mapImageLightUrl) deleteFromFirebase(ride.mapImageLightUrl).catch(() => {});
      if (ride.mapImageDarkUrl) deleteFromFirebase(ride.mapImageDarkUrl).catch(() => {});
    }

    // 3. Delete all route map images from Firebase Storage
    const routes = await Route.find({ creatorId: uid }, { mapImageLightUrl: 1, mapImageDarkUrl: 1 });
    for (const route of routes) {
      if (route.mapImageLightUrl) deleteFromFirebase(route.mapImageLightUrl).catch(() => {});
      if (route.mapImageDarkUrl) deleteFromFirebase(route.mapImageDarkUrl).catch(() => {});
    }

    // 4. Cascade delete all user data from MongoDB
    await Promise.all([
      Ride.deleteMany({ userId: uid }),
      Telemetry.deleteMany({ userId: uid }),
      Route.deleteMany({ creatorId: uid }),
      Trip.updateMany(
        { attendeeIds: uid },
        { $pull: { attendeeIds: uid } }
      ),
      Trip.deleteMany({ creatorId: uid }),
      // Remove user from other users' followers/following lists
      User.updateMany(
        { followers: uid },
        { $pull: { followers: uid } }
      ),
      User.updateMany(
        { following: uid },
        { $pull: { following: uid } }
      ),
      User.deleteOne({ firebaseUid: uid })
    ]);

    // 5. Delete Firebase Auth account
    try {
      await admin.auth().deleteUser(uid);
    } catch (authErr) {
      // Auth deletion may fail if already deleted; log but don't block response
      console.warn('Firebase Auth deletion warning:', authErr.message);
    }

    res.json({ message: 'Account permanently deleted' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
