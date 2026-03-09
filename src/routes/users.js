const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const User = require('../models/User');
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

module.exports = router;
