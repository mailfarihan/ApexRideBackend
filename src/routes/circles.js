const express = require('express');
const router = express.Router();
const Circle = require('../models/Circle');
const User = require('../models/User');
const Ride = require('../models/Ride');
const RideShare = require('../models/RideShare');

// Helper: hydrate a circle with member previews for the response payload
async function hydrate(circle, callerUid) {
  const memberUids = [...(circle.members || []).map(m => m.userId), ...(circle.pendingInvites || []).map(i => i.userId)];
  const users = memberUids.length === 0
    ? []
    : await User.find({ firebaseUid: { $in: memberUids } })
        .select('firebaseUid displayName username photoUrl')
        .lean();
  const byUid = Object.fromEntries(users.map(u => [u.firebaseUid, u]));

  const decorate = (uid) => {
    const u = byUid[uid];
    return {
      uid,
      displayName: u?.displayName || 'Rider',
      username: u?.username || null,
      photoUrl: u?.photoUrl || null
    };
  };

  return {
    id: circle._id.toString(),
    ownerId: circle.ownerId,
    name: circle.name,
    description: circle.description || '',
    isOwner: circle.ownerId === callerUid,
    members: (circle.members || []).map(m => ({
      ...decorate(m.userId),
      role: m.role,
      joinedAt: m.joinedAt
    })),
    pendingInvites: (circle.pendingInvites || []).map(i => ({
      ...decorate(i.userId),
      invitedAt: i.invitedAt,
      invitedBy: i.invitedBy
    })),
    memberCount: (circle.members || []).length,
    createdAt: circle.createdAt
  };
}

// GET /api/circles - List circles the caller owns or belongs to, plus any pending invites
router.get('/', async (req, res) => {
  try {
    const uid = req.user.uid;
    const [mine, invites] = await Promise.all([
      Circle.find({ $or: [{ ownerId: uid }, { 'members.userId': uid }] }).lean(),
      Circle.find({ 'pendingInvites.userId': uid }).lean()
    ]);
    const seen = new Set();
    const dedup = [];
    for (const c of [...mine, ...invites]) {
      const id = c._id.toString();
      if (seen.has(id)) continue;
      seen.add(id);
      dedup.push(c);
    }
    const hydrated = await Promise.all(dedup.map(c => hydrate(c, uid)));
    res.json(hydrated);
  } catch (error) {
    console.error('List circles error:', error);
    res.status(500).json({ error: 'Failed to list circles' });
  }
});

// POST /api/circles - Create a new circle (owner is auto-added as a member)
router.post('/', async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

    const circle = await Circle.create({
      ownerId: req.user.uid,
      name: String(name).trim().slice(0, 60),
      description: String(description || '').slice(0, 240),
      members: [{ userId: req.user.uid, role: 'owner' }]
    });
    res.status(201).json(await hydrate(circle, req.user.uid));
  } catch (error) {
    console.error('Create circle error:', error);
    res.status(500).json({ error: 'Failed to create circle' });
  }
});

// GET /api/circles/:id - Circle detail (must be member or invitee)
router.get('/:id', async (req, res) => {
  try {
    const circle = await Circle.findById(req.params.id).lean();
    if (!circle) return res.status(404).json({ error: 'Circle not found' });
    const uid = req.user.uid;
    const canView = circle.ownerId === uid
      || (circle.members || []).some(m => m.userId === uid)
      || (circle.pendingInvites || []).some(i => i.userId === uid);
    if (!canView) return res.status(403).json({ error: 'Not a member' });
    res.json(await hydrate(circle, uid));
  } catch (error) {
    console.error('Get circle error:', error);
    res.status(500).json({ error: 'Failed to get circle' });
  }
});

// PATCH /api/circles/:id - Owner can rename/redescribe
router.patch('/:id', async (req, res) => {
  try {
    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });
    if (circle.ownerId !== req.user.uid) return res.status(403).json({ error: 'Only owner may edit' });

    if (req.body.name !== undefined) circle.name = String(req.body.name).trim().slice(0, 60);
    if (req.body.description !== undefined) circle.description = String(req.body.description).slice(0, 240);
    await circle.save();
    res.json(await hydrate(circle.toObject(), req.user.uid));
  } catch (error) {
    console.error('Update circle error:', error);
    res.status(500).json({ error: 'Failed to update circle' });
  }
});

// DELETE /api/circles/:id - Owner deletes the circle (and dependent RideShares)
router.delete('/:id', async (req, res) => {
  try {
    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });
    if (circle.ownerId !== req.user.uid) return res.status(403).json({ error: 'Only owner may delete' });

    await RideShare.deleteMany({ 'sharedWith.type': 'circle', 'sharedWith.id': circle._id.toString() });
    await circle.deleteOne();
    res.json({ message: 'Circle deleted' });
  } catch (error) {
    console.error('Delete circle error:', error);
    res.status(500).json({ error: 'Failed to delete circle' });
  }
});

// POST /api/circles/:id/invite - Owner invites a user by uid
router.post('/:id/invite', async (req, res) => {
  try {
    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });
    if (circle.ownerId !== req.user.uid) return res.status(403).json({ error: 'Only owner may invite' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (userId === circle.ownerId) return res.status(400).json({ error: 'Owner already member' });

    const alreadyMember = (circle.members || []).some(m => m.userId === userId);
    const alreadyInvited = (circle.pendingInvites || []).some(i => i.userId === userId);
    if (alreadyMember) return res.status(409).json({ error: 'Already a member' });
    if (alreadyInvited) return res.status(409).json({ error: 'Already invited' });

    const target = await User.findOne({ firebaseUid: userId }).select('firebaseUid').lean();
    if (!target) return res.status(404).json({ error: 'User not found' });

    circle.pendingInvites.push({ userId, invitedBy: req.user.uid });
    await circle.save();
    res.json(await hydrate(circle.toObject(), req.user.uid));
  } catch (error) {
    console.error('Invite error:', error);
    res.status(500).json({ error: 'Failed to invite' });
  }
});

// POST /api/circles/:id/accept - Caller accepts a pending invite
router.post('/:id/accept', async (req, res) => {
  try {
    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    const uid = req.user.uid;
    const inviteIdx = (circle.pendingInvites || []).findIndex(i => i.userId === uid);
    if (inviteIdx === -1) return res.status(404).json({ error: 'No pending invite' });

    circle.pendingInvites.splice(inviteIdx, 1);
    if (!(circle.members || []).some(m => m.userId === uid)) {
      circle.members.push({ userId: uid, role: 'member' });
    }
    await circle.save();
    res.json(await hydrate(circle.toObject(), uid));
  } catch (error) {
    console.error('Accept invite error:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// POST /api/circles/:id/decline - Caller declines a pending invite
router.post('/:id/decline', async (req, res) => {
  try {
    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    const uid = req.user.uid;
    const before = (circle.pendingInvites || []).length;
    circle.pendingInvites = (circle.pendingInvites || []).filter(i => i.userId !== uid);
    if (before === circle.pendingInvites.length) return res.status(404).json({ error: 'No pending invite' });

    await circle.save();
    res.json({ message: 'Invite declined' });
  } catch (error) {
    console.error('Decline invite error:', error);
    res.status(500).json({ error: 'Failed to decline invite' });
  }
});

// POST /api/circles/:id/leave - Member leaves the circle (owner cannot leave; must delete)
router.post('/:id/leave', async (req, res) => {
  try {
    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    const uid = req.user.uid;
    if (circle.ownerId === uid) return res.status(400).json({ error: 'Owner must delete the circle to leave' });

    const before = (circle.members || []).length;
    circle.members = (circle.members || []).filter(m => m.userId !== uid);
    if (before === circle.members.length) return res.status(404).json({ error: 'Not a member' });

    await circle.save();
    res.json({ message: 'Left circle' });
  } catch (error) {
    console.error('Leave circle error:', error);
    res.status(500).json({ error: 'Failed to leave circle' });
  }
});

// DELETE /api/circles/:id/members/:uid - Owner removes a member (or cancels an invite)
router.delete('/:id/members/:uid', async (req, res) => {
  try {
    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });
    if (circle.ownerId !== req.user.uid) return res.status(403).json({ error: 'Only owner may remove members' });

    const target = req.params.uid;
    if (target === circle.ownerId) return res.status(400).json({ error: 'Cannot remove owner' });

    circle.members = (circle.members || []).filter(m => m.userId !== target);
    circle.pendingInvites = (circle.pendingInvites || []).filter(i => i.userId !== target);
    await circle.save();
    res.json(await hydrate(circle.toObject(), req.user.uid));
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// GET /api/circles/feed/activity - Rides shared with the caller via any circle they belong to.
// Returns the most recent ~50 ride summaries with owner display info.
router.get('/feed/activity', async (req, res) => {
  try {
    const uid = req.user.uid;
    const circles = await Circle.find({ 'members.userId': uid }).select('_id').lean();
    const circleIds = circles.map(c => c._id.toString());
    if (circleIds.length === 0) return res.json([]);

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));

    const shares = await RideShare.find({
      'sharedWith.type': 'circle',
      'sharedWith.id': { $in: circleIds },
      ownerId: { $ne: uid }
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    if (shares.length === 0) return res.json([]);

    const rideIds = shares.map(s => s.rideId);
    const ownerIds = [...new Set(shares.map(s => s.ownerId))];
    const [rides, owners] = await Promise.all([
      Ride.find({ _id: { $in: rideIds } })
        .select('-routePointsJson -eventsJson -telemetry -samples')
        .lean(),
      User.find({ firebaseUid: { $in: ownerIds } })
        .select('firebaseUid displayName username photoUrl')
        .lean()
    ]);
    const rideById = Object.fromEntries(rides.map(r => [r._id.toString(), r]));
    const ownerById = Object.fromEntries(owners.map(u => [u.firebaseUid, u]));

    const items = shares
      .map(share => {
        const ride = rideById[share.rideId.toString()];
        if (!ride) return null;
        const owner = ownerById[share.ownerId];
        return {
          shareId: share._id.toString(),
          sharedAt: share.createdAt,
          circleId: share.sharedWith.id,
          ride: {
            id: ride._id.toString(),
            userId: ride.userId,
            startTime: ride.startTime,
            endTime: ride.endTime,
            distance: ride.distance,
            duration: ride.duration,
            avgSpeed: ride.avgSpeed,
            maxSpeed: ride.maxSpeed,
            maxLeanAngle: ride.maxLeanAngle,
            maxGForce: ride.maxGForce,
            title: ride.title || '',
            region: ride.region || '',
            encodedPolyline: ride.encodedPolyline || '',
            mapImageLightUrl: ride.mapImageLightUrl || '',
            mapImageDarkUrl: ride.mapImageDarkUrl || ''
          },
          owner: {
            uid: share.ownerId,
            displayName: owner?.displayName || 'Rider',
            username: owner?.username || null,
            photoUrl: owner?.photoUrl || null
          }
        };
      })
      .filter(Boolean);

    res.json(items);
  } catch (error) {
    console.error('Activity feed error:', error);
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

module.exports = router;
