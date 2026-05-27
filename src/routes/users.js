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

    // Auto-reactivate: if user logs back in before 30 days, cancel deletion
    if (user.deletionScheduledAt) {
      console.log(`Account auto-reactivated on login - uid: ${req.user.uid}`);
      user.deletionScheduledAt = null;
      user.deletionReason = null;
      user.deletionFeedback = null;
      await user.save();
    }

    // Augment with social counts for the self view
    const obj = user.toObject();
    obj.followerCount = (user.followers || []).length;
    obj.followingCount = (user.following || []).length;
    obj.followRequestCount = (user.followRequests || []).length;
    obj.pendingFollowCount = (user.pendingFollows || []).length;
    res.json(obj);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// GET /api/users/me/username-check - Check if a username is available
router.get('/me/username-check', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });

    const clean = username.toLowerCase().trim();
    if (!/^[a-z0-9_]{3,20}$/.test(clean)) {
      return res.json({ available: false, reason: 'Username must be 3-20 characters: lowercase letters, numbers, underscores only' });
    }

    const existing = await User.findOne({ username: clean });
    const isOwnUsername = existing?.firebaseUid === req.user.uid;
    res.json({ available: !existing || isOwnUsername });
  } catch (error) {
    res.status(500).json({ error: 'Check failed' });
  }
});

// PUT /api/users/me - Update current user's profile
router.put('/me', async (req, res) => {
  try {
    const updates = {};
    const allowedFields = ['displayName', 'bio', 'photoUrl', 'motorcycle', 'preferences', 'isPrivate'];
    
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // Handle username separately — needs validation + uniqueness check
    if (req.body.username !== undefined) {
      const raw = req.body.username;
      if (raw === null || raw === '') {
        updates.username = null;
      } else {
        const clean = String(raw).toLowerCase().trim();
        if (!/^[a-z0-9_]{3,20}$/.test(clean)) {
          return res.status(400).json({ error: 'Username must be 3-20 characters: lowercase letters, numbers, underscores only' });
        }
        const conflict = await User.findOne({ username: clean });
        if (conflict && conflict.firebaseUid !== req.user.uid) {
          return res.status(409).json({ error: 'Username already taken' });
        }
        updates.username = clean;
      }
    }

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
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/users/me/location - Update caller's last known location (auto-shared with circles)
router.post('/me/location', async (req, res) => {
  try {
    const { lat, lng, isLive } = req.body || {};
    const latN = Number(lat);
    const lngN = Number(lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }
    if (latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
      return res.status(400).json({ error: 'lat/lng out of range' });
    }
    await User.updateOne(
      { firebaseUid: req.user.uid },
      {
        $set: {
          'lastLocation.lat': latN,
          'lastLocation.lng': lngN,
          'lastLocation.ts': new Date(),
          'lastLocation.isLive': Boolean(isLive)
        }
      },
      { upsert: false }
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
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

// GET /api/users/search?q=... - Prefix-match search across displayName + username
// Returns up to 20 users, each tagged with isFollowing for the caller.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) return res.json([]);

    // Escape user input for safe regex usage
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = new RegExp('^' + esc, 'i');

    const me = await User.findOne({ firebaseUid: req.user.uid }).select('following pendingFollows').lean();
    const followingSet = new Set(me?.following || []);
    const pendingSet = new Set(me?.pendingFollows || []);

    const matches = await User.find({
      firebaseUid: { $ne: req.user.uid },
      deletionScheduledAt: null,
      $or: [
        { displayName: prefix },
        { username: prefix }
      ]
    })
      .select('firebaseUid displayName username photoUrl')
      .limit(20)
      .lean();

    res.json(matches.map(u => ({
      uid: u.firebaseUid,
      firebaseUid: u.firebaseUid,
      displayName: u.displayName || 'Rider',
      username: u.username || null,
      photoUrl: u.photoUrl || null,
      isFollowing: followingSet.has(u.firebaseUid),
      followStatus: followingSet.has(u.firebaseUid)
        ? 'following'
        : (pendingSet.has(u.firebaseUid) ? 'requested' : 'none')
    })));
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/users/me/follow-requests - Incoming follow requests for caller
router.get('/me/follow-requests', async (req, res) => {
  try {
    const me = await User.findOne({ firebaseUid: req.user.uid }).select('followRequests').lean();
    const uids = me?.followRequests || [];
    const result = await fetchUserPreviews(uids, req.user.uid, 1, 200);
    res.json(result);
  } catch (error) {
    console.error('Get follow requests error:', error);
    res.status(500).json({ error: 'Failed to get follow requests' });
  }
});

// GET /api/users/me/connections?q=... - Union of caller's followers + following,
// optionally filtered by prefix. Source of invitable users for circles.
router.get('/me/connections', async (req, res) => {
  try {
    const me = await User.findOne({ firebaseUid: req.user.uid })
      .select('followers following')
      .lean();
    if (!me) return res.json([]);

    const set = new Set([...(me.followers || []), ...(me.following || [])]);
    set.delete(req.user.uid);
    if (set.size === 0) return res.json([]);

    const q = (req.query.q || '').toString().trim();
    const baseFilter = {
      firebaseUid: { $in: Array.from(set) },
      deletionScheduledAt: null
    };
    if (q.length > 0) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp('^' + escaped, 'i');
      baseFilter.$or = [{ displayName: rx }, { username: rx }];
    }

    const users = await User.find(baseFilter)
      .select('firebaseUid displayName username photoUrl')
      .limit(50)
      .lean();

    const followingSet = new Set(me.following || []);
    res.json(users.map(u => ({
      uid: u.firebaseUid,
      firebaseUid: u.firebaseUid,
      displayName: u.displayName || 'Rider',
      username: u.username || null,
      photoUrl: u.photoUrl || null,
      isFollowing: followingSet.has(u.firebaseUid),
      followStatus: followingSet.has(u.firebaseUid) ? 'following' : 'none'
    })));
  } catch (error) {
    console.error('Get connections error:', error);
    res.status(500).json({ error: 'Failed to get connections' });
  }
});

// GET /api/users/:uid - Get another user's public profile (+ social counts + isFollowing)
router.get('/:uid', async (req, res) => {
  try {
    const user = await User.findOne(
      { firebaseUid: req.params.uid },
      { email: 0, preferences: 0 } // Exclude private fields
    ).lean();

    if (!user || user.deletionScheduledAt) {
      return res.status(404).json({ error: 'User not found' });
    }

    const me = await User.findOne({ firebaseUid: req.user.uid })
      .select('following pendingFollows followRequests').lean();
    const followingList = me?.following || [];
    const pendingList = me?.pendingFollows || [];
    const incomingList = me?.followRequests || [];
    const isSelf = user.firebaseUid === req.user.uid;
    const isFollowing = followingList.includes(user.firebaseUid);
    const isRequested = pendingList.includes(user.firebaseUid);
    const followStatus = isSelf
      ? 'self'
      : (isFollowing ? 'following' : (isRequested ? 'requested' : 'none'));

    res.json({
      ...user,
      uid: user.firebaseUid,
      followerCount: (user.followers || []).length,
      followingCount: (user.following || []).length,
      isFollowing,
      followStatus,
      isPrivate: !!user.isPrivate,
      // Whether the caller has an incoming request from this profile (i.e. this user wants to follow me)
      hasIncomingRequest: incomingList.includes(user.firebaseUid),
      isSelf,
      followers: undefined,
      following: undefined,
      followRequests: undefined,
      pendingFollows: undefined
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// GET /api/users/:uid/rides?public=true - Public rides for non-owner; full list for owner
router.get('/:uid/rides', async (req, res) => {
  try {
    const isOwner = req.params.uid === req.user.uid;
    const publicOnly = !isOwner || req.query.public === 'true';

    const filter = { userId: req.params.uid };
    if (publicOnly) filter.isPublic = true;

    const rides = await Ride.find(filter)
      .sort({ startTime: -1 })
      .limit(100)
      .select('-routePointsJson -eventsJson -telemetry -samples')
      .lean();

    res.json(rides);
  } catch (error) {
    console.error('Get user rides error:', error);
    res.status(500).json({ error: 'Failed to get rides' });
  }
});

// Helper: paginate a list of UIDs into user previews tagged with followStatus
async function fetchUserPreviews(uids, callerUid, page, limit) {
  const start = Math.max(0, (page - 1) * limit);
  const slice = uids.slice(start, start + limit);
  if (slice.length === 0) return { items: [], total: uids.length, page, limit };

  const me = await User.findOne({ firebaseUid: callerUid }).select('following pendingFollows').lean();
  const followingSet = new Set(me?.following || []);
  const pendingSet = new Set(me?.pendingFollows || []);

  const users = await User.find({ firebaseUid: { $in: slice } })
    .select('firebaseUid displayName username photoUrl')
    .lean();
  const byUid = Object.fromEntries(users.map(u => [u.firebaseUid, u]));

  const items = slice
    .map(uid => byUid[uid])
    .filter(Boolean)
    .map(u => ({
      uid: u.firebaseUid,
      firebaseUid: u.firebaseUid,
      displayName: u.displayName || 'Rider',
      username: u.username || null,
      photoUrl: u.photoUrl || null,
      isFollowing: followingSet.has(u.firebaseUid),
      followStatus: u.firebaseUid === callerUid
        ? 'self'
        : (followingSet.has(u.firebaseUid)
            ? 'following'
            : (pendingSet.has(u.firebaseUid) ? 'requested' : 'none'))
    }));

  return { items, total: uids.length, page, limit };
}

// GET /api/users/:uid/followers?page=1&limit=30
router.get('/:uid/followers', async (req, res) => {
  try {
    const target = await User.findOne({ firebaseUid: req.params.uid }).select('followers').lean();
    if (!target) return res.status(404).json({ error: 'User not found' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    res.json(await fetchUserPreviews(target.followers || [], req.user.uid, page, limit));
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ error: 'Failed to get followers' });
  }
});

// GET /api/users/:uid/following?page=1&limit=30
router.get('/:uid/following', async (req, res) => {
  try {
    const target = await User.findOne({ firebaseUid: req.params.uid }).select('following').lean();
    if (!target) return res.status(404).json({ error: 'User not found' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    res.json(await fetchUserPreviews(target.following || [], req.user.uid, page, limit));
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Failed to get following' });
  }
});

// POST /api/users/:uid/follow - Follow a user (or send a request if target is private)
router.post('/:uid/follow', async (req, res) => {
  try {
    if (req.params.uid === req.user.uid) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    const target = await User.findOne({ firebaseUid: req.params.uid }).select('isPrivate followers').lean();
    if (!target) return res.status(404).json({ error: 'User not found' });

    const alreadyFollower = (target.followers || []).includes(req.user.uid);

    if (target.isPrivate && !alreadyFollower) {
      // Private target — store as pending request instead of following directly
      await User.findOneAndUpdate(
        { firebaseUid: req.user.uid },
        { $addToSet: { pendingFollows: req.params.uid } },
        { upsert: true }
      );
      await User.findOneAndUpdate(
        { firebaseUid: req.params.uid },
        { $addToSet: { followRequests: req.user.uid } }
      );
      return res.json({ status: 'requested', message: 'Follow request sent' });
    }

    // Public target — follow directly
    await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      {
        $addToSet: { following: req.params.uid },
        $pull: { pendingFollows: req.params.uid }
      },
      { upsert: true }
    );
    await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      {
        $addToSet: { followers: req.user.uid },
        $pull: { followRequests: req.user.uid }
      }
    );

    res.json({ status: 'following', message: 'Followed user' });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

// Internal unfollow / cancel-request handler
async function unfollowHandler(req, res) {
  try {
    await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      { $pull: { following: req.params.uid, pendingFollows: req.params.uid } }
    );
    await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { $pull: { followers: req.user.uid, followRequests: req.user.uid } }
    );
    res.json({ status: 'none', message: 'Unfollowed user' });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
}

// POST /api/users/:uid/unfollow - Unfollow / cancel request (legacy path)
router.post('/:uid/unfollow', unfollowHandler);

// DELETE /api/users/:uid/follow - Unfollow / cancel request (REST-y alias)
router.delete('/:uid/follow', unfollowHandler);

// POST /api/users/:uid/follow-request/accept - Caller (B) accepts request from A (=:uid)
router.post('/:uid/follow-request/accept', async (req, res) => {
  try {
    const requesterUid = req.params.uid;
    if (requesterUid === req.user.uid) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const me = await User.findOne({ firebaseUid: req.user.uid }).select('followRequests').lean();
    if (!(me?.followRequests || []).includes(requesterUid)) {
      return res.status(404).json({ error: 'No pending request from this user' });
    }

    await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      {
        $addToSet: { followers: requesterUid },
        $pull: { followRequests: requesterUid }
      }
    );
    await User.findOneAndUpdate(
      { firebaseUid: requesterUid },
      {
        $addToSet: { following: req.user.uid },
        $pull: { pendingFollows: req.user.uid }
      }
    );

    res.json({ message: 'Follow request accepted' });
  } catch (error) {
    console.error('Accept follow request error:', error);
    res.status(500).json({ error: 'Failed to accept follow request' });
  }
});

// POST /api/users/:uid/follow-request/decline - Caller (B) declines request from A (=:uid)
router.post('/:uid/follow-request/decline', async (req, res) => {
  try {
    const requesterUid = req.params.uid;
    await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      { $pull: { followRequests: requesterUid } }
    );
    await User.findOneAndUpdate(
      { firebaseUid: requesterUid },
      { $pull: { pendingFollows: req.user.uid } }
    );
    res.json({ message: 'Follow request declined' });
  } catch (error) {
    console.error('Decline follow request error:', error);
    res.status(500).json({ error: 'Failed to decline follow request' });
  }
});

// DELETE /api/users/me - Schedule account for deletion (30-day grace period)
router.delete('/me', async (req, res) => {
  try {
    const uid = req.user.uid;
    const { reason, feedback } = req.body || {};

    const user = await User.findOne({ firebaseUid: uid });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log deletion reason
    if (reason || feedback) {
      console.log(`Account deletion scheduled - uid: ${uid}, reason: ${reason || 'none'}, feedback: ${feedback || 'none'}`);
    }

    // Soft delete: schedule for 30 days from now
    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + 30);

    user.deletionScheduledAt = deletionDate;
    user.deletionReason = reason || null;
    user.deletionFeedback = feedback || null;
    await user.save();

    res.json({ 
      message: 'Account scheduled for deletion',
      deletionScheduledAt: deletionDate.toISOString()
    });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to schedule account deletion' });
  }
});

// POST /api/users/me/reactivate - Cancel scheduled deletion
router.post('/me/reactivate', async (req, res) => {
  try {
    const uid = req.user.uid;

    const user = await User.findOne({ firebaseUid: uid });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.deletionScheduledAt) {
      return res.json({ message: 'Account is not scheduled for deletion' });
    }

    console.log(`Account reactivated - uid: ${uid}`);
    user.deletionScheduledAt = null;
    user.deletionReason = null;
    user.deletionFeedback = null;
    await user.save();

    res.json({ message: 'Account reactivated successfully' });
  } catch (error) {
    console.error('Reactivate account error:', error);
    res.status(500).json({ error: 'Failed to reactivate account' });
  }
});

module.exports = router;
