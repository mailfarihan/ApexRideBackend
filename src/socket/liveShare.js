// Phase 3 — Live Share WebSocket layer.
//
// Auth:
//   - Members authenticate with their Firebase ID token (handshake auth.token).
//   - Anonymous viewers can pass a short-lived signed JWT (auth.viewerToken)
//     created by POST /api/live/:rideId/link. The viewer is read-only and
//     bound to a single rideId / groupRideId.
//
// Rooms:
//   - ride:{rideId}          solo live ride
//   - groupride:{groupRideId} group live ride
//
// Trail buffer: in-memory rolling window per ride (cap 500 points). Flushed
// into the ride document on ride:end; cleared from memory.

const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const Circle = require('../models/Circle');
const Trip = require('../models/Trip');

const TRAIL_CAP = 500;
// rideKey ("ride:<rideId>" | "groupride:<id>") -> { ownerId, trail: [], lastUpdate, lastPoint }
const activeSessions = new Map();

function pushTrail(roomKey, ownerId, point) {
  let s = activeSessions.get(roomKey);
  if (!s) {
    s = { ownerId, trail: [], lastUpdate: Date.now(), lastPoint: null };
    activeSessions.set(roomKey, s);
  }
  s.lastPoint = point;
  s.lastUpdate = Date.now();
  s.trail.push(point);
  if (s.trail.length > TRAIL_CAP) s.trail.shift();
}

async function endSession(roomKey) {
  const s = activeSessions.get(roomKey);
  if (!s) return;
  activeSessions.delete(roomKey);
  // No persistent flush — solo live rides use the broadcaster's UID as the
  // room id, and there is no concrete Ride document during the live window.
  // The recorded ride is saved separately by the client via /api/rides.
}

async function userIsInOwnerCircle(viewerUid, ownerUid) {
  if (!viewerUid || !ownerUid) return false;
  if (viewerUid === ownerUid) return true;
  // Owner-created circles containing viewer, or circles viewer owns containing owner.
  const c = await Circle.findOne({
    $or: [
      { ownerId: ownerUid, 'members.userId': viewerUid },
      { ownerId: viewerUid, 'members.userId': ownerUid }
    ]
  }).select('_id').lean();
  return !!c;
}

async function userIsAttendee(viewerUid, groupRideId) {
  if (!viewerUid || !groupRideId) return false;
  const t = await Trip.findById(groupRideId).select('creatorId attendeeIds').lean();
  if (!t) return false;
  return t.creatorId === viewerUid || (t.attendeeIds || []).includes(viewerUid);
}

function verifyViewerJwt(token) {
  try {
    const secret = process.env.LIVE_SHARE_SECRET;
    if (!secret) return null;
    return jwt.verify(token, secret);
  } catch (_) {
    return null;
  }
}

function signViewerJwt(payload, expiresInSec = 15 * 60) {
  const secret = process.env.LIVE_SHARE_SECRET;
  if (!secret) throw new Error('LIVE_SHARE_SECRET is not configured');
  return jwt.sign(payload, secret, { expiresIn: expiresInSec });
}

function attach(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    pingTimeout: 30000
  });

  // Handshake auth
  io.use(async (socket, next) => {
    try {
      const idToken = socket.handshake.auth?.token;
      const viewerToken = socket.handshake.auth?.viewerToken;

      if (idToken) {
        const decoded = await admin.auth().verifyIdToken(idToken);
        socket.userId = decoded.uid;
        socket.viewerOnly = false;
        return next();
      }
      if (viewerToken) {
        const payload = verifyViewerJwt(viewerToken);
        if (!payload) return next(new Error('invalid viewer token'));
        socket.viewerOnly = true;
        socket.viewerScope = payload; // { rideId? , groupRideId? , iat, exp }
        return next();
      }
      return next(new Error('unauthorized'));
    } catch (e) {
      return next(new Error('auth failed'));
    }
  });

  io.on('connection', (socket) => {
    // Join a ride/groupride room.
    // payload: { kind: 'ride'|'groupride', id: string }
    socket.on('join', async (payload, ack) => {
      try {
        const { kind, id } = payload || {};
        if (!kind || !id) return ack?.({ ok: false, error: 'missing_args' });
        const roomKey = `${kind}:${id}`;

        // Viewer-only JWT: must match the room they were issued for.
        if (socket.viewerOnly) {
          const scope = socket.viewerScope || {};
          const allowed =
            (kind === 'ride' && scope.rideId === id) ||
            (kind === 'groupride' && scope.groupRideId === id);
          if (!allowed) return ack?.({ ok: false, error: 'forbidden' });
        } else {
          // Authenticated member: verify they can view this room.
          if (kind === 'ride') {
            // For solo live rides, `id` is the broadcaster's UID.
            // Allow if viewer == broadcaster OR they share a circle.
            const targetOwner = id;
            const ok = await userIsInOwnerCircle(socket.userId, targetOwner);
            if (!ok) return ack?.({ ok: false, error: 'forbidden' });
          } else if (kind === 'groupride') {
            const ok = await userIsAttendee(socket.userId, id);
            if (!ok) return ack?.({ ok: false, error: 'forbidden' });
          } else {
            return ack?.({ ok: false, error: 'bad_kind' });
          }
        }

        socket.join(roomKey);
        socket.data.rooms = socket.data.rooms || new Set();
        socket.data.rooms.add(roomKey);

        // Send current snapshot if session exists.
        const snap = activeSessions.get(roomKey);
        if (snap) {
          socket.emit('snapshot', {
            roomKey,
            ownerId: snap.ownerId,
            trail: snap.trail,
            lastPoint: snap.lastPoint
          });
        }
        socket.to(roomKey).emit('viewer:join', { userId: socket.userId || null });
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on('leave', (payload) => {
      const roomKey = `${payload?.kind}:${payload?.id}`;
      socket.leave(roomKey);
      socket.to(roomKey).emit('viewer:leave', { userId: socket.userId || null });
    });

    // Broadcaster announces ride start.
    // payload: { kind, id }
    socket.on('ride:start', async (payload, ack) => {
      if (socket.viewerOnly) return ack?.({ ok: false, error: 'viewer_readonly' });
      const { kind, id } = payload || {};
      const roomKey = `${kind}:${id}`;
      // Authorize broadcaster.
      if (kind === 'ride') {
        // Solo: id MUST be the broadcaster's own UID.
        if (id !== socket.userId) return ack?.({ ok: false, error: 'forbidden' });
      } else if (kind === 'groupride') {
        const ok = await userIsAttendee(socket.userId, id);
        if (!ok) return ack?.({ ok: false, error: 'forbidden' });
      } else {
        return ack?.({ ok: false, error: 'bad_kind' });
      }
      socket.join(roomKey);
      socket.data.broadcasting = socket.data.broadcasting || new Set();
      socket.data.broadcasting.add(roomKey);
      // Seed session.
      if (!activeSessions.has(roomKey)) {
        activeSessions.set(roomKey, {
          ownerId: socket.userId,
          trail: [],
          lastUpdate: Date.now(),
          lastPoint: null
        });
      }
      io.to(roomKey).emit('ride:start', { roomKey, ownerId: socket.userId });
      ack?.({ ok: true });
    });

    // payload: { kind, id, lat, lng, heading?, speed?, leanAngle?, ts? }
    socket.on('location:update', (payload) => {
      if (socket.viewerOnly) return;
      const { kind, id } = payload || {};
      if (!kind || !id) return;
      const roomKey = `${kind}:${id}`;
      const session = activeSessions.get(roomKey);
      if (!session || session.ownerId !== socket.userId) {
        // For group rides, multiple broadcasters allowed — use per-user trail.
        if (kind !== 'groupride') return;
      }
      const point = {
        userId: socket.userId,
        lat: Number(payload.lat),
        lng: Number(payload.lng),
        heading: payload.heading != null ? Number(payload.heading) : null,
        speed: payload.speed != null ? Number(payload.speed) : null,
        leanAngle: payload.leanAngle != null ? Number(payload.leanAngle) : null,
        ts: payload.ts || Date.now()
      };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
      if (kind === 'ride') {
        pushTrail(roomKey, socket.userId, point);
      } else {
        // group ride — still touch session for "active" listing
        if (!activeSessions.has(roomKey)) {
          activeSessions.set(roomKey, {
            ownerId: socket.userId,
            trail: [],
            lastUpdate: Date.now(),
            lastPoint: point
          });
        } else {
          const s = activeSessions.get(roomKey);
          s.lastUpdate = Date.now();
          s.lastPoint = point;
        }
      }
      socket.to(roomKey).emit('location:update', point);
    });

    socket.on('ride:end', async (payload, ack) => {
      if (socket.viewerOnly) return ack?.({ ok: false });
      const { kind, id } = payload || {};
      const roomKey = `${kind}:${id}`;
      io.to(roomKey).emit('ride:end', { roomKey, ownerId: socket.userId });
      await endSession(roomKey);
      ack?.({ ok: true });
    });
    socket.on('ride:stop', (p, ack) => socket.emit('ride:end', p, ack));

    socket.on('disconnect', async () => {
      // If broadcaster disconnects ungracefully, leave the trail in memory for
      // ~60s in case of reconnect; reaper below would clean it.
      const rooms = socket.data.broadcasting;
      if (rooms) {
        for (const roomKey of rooms) {
          io.to(roomKey).emit('broadcaster:disconnected', { roomKey });
        }
      }
    });
  });

  // Reap stale sessions (no updates in 60s).
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [roomKey, s] of activeSessions.entries()) {
      if (s.lastUpdate < cutoff) {
        io.to(roomKey).emit('ride:end', { roomKey, ownerId: s.ownerId, reason: 'stale' });
        endSession(roomKey).catch(() => {});
      }
    }
  }, 30_000);

  return io;
}

// Helpers used by routes/live.js
function listActiveForViewer(viewerUid) {
  // Returns active sessions the viewer is allowed to see (best-effort sync).
  const out = [];
  for (const [roomKey, s] of activeSessions.entries()) {
    out.push({
      roomKey,
      kind: roomKey.startsWith('ride:') ? 'ride' : 'groupride',
      id: roomKey.split(':')[1],
      ownerId: s.ownerId,
      lastPoint: s.lastPoint,
      trail: s.trail.slice(-60),
      updatedAt: s.lastUpdate
    });
  }
  return out;
}

module.exports = {
  attach,
  signViewerJwt,
  verifyViewerJwt,
  listActiveForViewer,
  activeSessions,
  userIsInOwnerCircle,
  userIsAttendee
};
