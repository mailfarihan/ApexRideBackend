const express = require('express');
const router = express.Router();
const User = require('../models/User');

/**
 * POST /api/auth/google
 * Sync Google authenticated user to MongoDB
 * Creates new user if not exists, updates if exists
 */
router.post('/google', async (req, res) => {
  try {
    const { firebaseUid, email, displayName, photoUrl } = req.body;
    
    // Validate required fields
    if (!firebaseUid) {
      return res.status(400).json({ error: 'firebaseUid is required' });
    }
    
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    
    // Find existing user or create new one
    let user = await User.findOne({ firebaseUid });
    
    if (!user) {
      // Create new user
      user = await User.create({
        firebaseUid,
        email,
        displayName: displayName || 'Rider',
        photoUrl: photoUrl || null,
        bio: '',
        motorcycle: {
          make: '',
          model: '',
          year: null
        },
        stats: {
          totalRides: 0,
          totalDistance: 0,
          publishedRoutes: 0
        },
        preferences: {
          units: 'metric',
          notifications: true
        },
        followers: [],
        following: [],
        createdAt: new Date()
      });
      
      console.log(`✅ Created new user: ${email} (${firebaseUid})`);
    } else {
      // Update existing user with latest info from Google
      user.email = email;
      if (displayName) user.displayName = displayName;
      if (photoUrl) user.photoUrl = photoUrl;
      user.updatedAt = new Date();
      await user.save();
      
      console.log(`✅ Updated existing user: ${email} (${firebaseUid})`);
    }
    
    res.json({
      firebaseUid: user.firebaseUid,
      email: user.email,
      displayName: user.displayName,
      photoUrl: user.photoUrl,
      bio: user.bio,
      motorcycle: user.motorcycle,
      stats: user.stats,
      preferences: user.preferences,
      followers: user.followers,
      following: user.following,
      createdAt: user.createdAt
    });
    
  } catch (error) {
    console.error('❌ Google auth sync error:', error);
    
    if (error.code === 11000) {
      // Duplicate key error - user already exists with different email
      return res.status(409).json({ error: 'User already exists' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
