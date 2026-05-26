/**
 * Group ride session clustering + fork-out trim.
 *
 * JS port of ApexRide/app/.../ui/screens/trips/GroupRideSessionUtils.kt.
 * Keep constants in sync with the Kotlin file.
 */

// ── Phantom / clustering constants ─────────────────────────────────
const PHANTOM_MIN_DISTANCE_M = 500.0;
const PHANTOM_MIN_AVG_SPEED_MPS = 5;
const SESSION_GAP_MS = 3 * 60 * 1000; // 3 min

// ── Fork-out trim constants ────────────────────────────────────────
const FORK_RADIUS_M = 1500;
const FORK_SUSTAINED_MS = 10 * 60 * 1000; // 10 min
const FORK_SAMPLE_INTERVAL_MS = 30 * 1000; // 30 s

// ── Polyline codec (Google Polyline Algorithm) ─────────────────────
function decodePolyline(encoded) {
  if (!encoded) return [];
  const points = [];
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;
  while (index < len) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function encodePolyline(points) {
  if (!points || points.length === 0) return '';
  let lastLat = 0;
  let lastLng = 0;
  let result = '';
  const encodeSigned = (val) => {
    let v = val < 0 ? ~(val << 1) : (val << 1);
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>>= 5;
    }
    out += String.fromCharCode(v + 63);
    return out;
  };
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    result += encodeSigned(latE5 - lastLat);
    result += encodeSigned(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return result;
}

// ── Distance helper (Haversine, meters) ────────────────────────────
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function polylineCumDist(points) {
  const n = points.length;
  const arr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arr[i] =
      arr[i - 1] +
      distanceMeters(
        points[i - 1][0],
        points[i - 1][1],
        points[i][0],
        points[i][1]
      );
  }
  return arr;
}

// ── Clustering ─────────────────────────────────────────────────────
function isPhantom(ride) {
  return (
    (ride.distance || 0) < PHANTOM_MIN_DISTANCE_M &&
    (ride.avgSpeed || 0) < PHANTOM_MIN_AVG_SPEED_MPS
  );
}

function effectiveEndTime(ride) {
  if (typeof ride.endTime === 'number') return ride.endTime;
  return (ride.startTime || 0) + (ride.duration || 0);
}

/**
 * @returns {{ sessions: Array<{sessionNumber, startTime, endTime, rideIds}>, rideToSession: Object<rideId,number|null> }}
 */
function clusterRidesIntoSessions(memberRides) {
  const valid = memberRides
    .filter((r) => !isPhantom(r))
    .slice()
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  const rideToSession = {};
  memberRides.forEach((r) => {
    rideToSession[String(r._id || r.id)] = null;
  });

  if (valid.length === 0) return { sessions: [], rideToSession };

  const clusters = [];
  const first = valid[0];
  clusters.push({
    start: first.startTime,
    end: effectiveEndTime(first),
    ids: [String(first._id || first.id)],
  });
  for (let i = 1; i < valid.length; i++) {
    const r = valid[i];
    const rEnd = effectiveEndTime(r);
    const last = clusters[clusters.length - 1];
    if (r.startTime - last.end <= SESSION_GAP_MS) {
      last.end = Math.max(last.end, rEnd);
      last.ids.push(String(r._id || r.id));
    } else {
      clusters.push({ start: r.startTime, end: rEnd, ids: [String(r._id || r.id)] });
    }
  }

  const sessions = clusters.map((c, idx) => ({
    sessionNumber: idx + 1,
    startTime: c.start,
    endTime: c.end,
    rideIds: c.ids,
  }));
  sessions.forEach((s) => s.rideIds.forEach((id) => { rideToSession[id] = s.sessionNumber; }));
  return { sessions, rideToSession };
}

// ── Position-at-time helpers ──────────────────────────────────────
function positionAtCumDist(points, polyCumDist, targetDist) {
  if (points.length === 0 || polyCumDist.length === 0) return null;
  const total = polyCumDist[polyCumDist.length - 1];
  if (total <= 0) return points[0];
  const td = Math.max(0, Math.min(total, targetDist));
  let lo = 0;
  let hi = polyCumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (polyCumDist[mid] <= td) lo = mid;
    else hi = mid;
  }
  const d1 = polyCumDist[lo];
  const d2 = polyCumDist[hi];
  const t = d2 > d1 ? Math.max(0, Math.min(1, (td - d1) / (d2 - d1))) : 0;
  return [
    points[lo][0] + t * (points[hi][0] - points[lo][0]),
    points[lo][1] + t * (points[hi][1] - points[lo][1]),
  ];
}

function memberPositionAtTime(tele, points, polyCumDist, t) {
  const ts = tele.timestamp;
  const cum = tele.cumDistanceM;
  if (!ts || ts.length === 0 || !cum || cum.length === 0) return null;
  if (t < ts[0] || t > ts[ts.length - 1]) return null;
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const idx = t - ts[lo] <= ts[hi] - t ? lo : hi;
  const safeIdx = Math.max(0, Math.min(cum.length - 1, idx));
  return positionAtCumDist(points, polyCumDist, cum[safeIdx]);
}

// ── Fork detection ────────────────────────────────────────────────
/**
 * @param ridesInSession - rides for one session
 * @param telemetryByRideId - rideId -> { timestamp, cumDistanceM, ... }
 * @param polyByRideId - rideId -> { points: [[lat,lng]...], cumDist: Float64Array }
 * @returns Object<rideId, cutoffMs|null>
 */
function computeForkCutoffs(ridesInSession, telemetryByRideId, polyByRideId) {
  const byUser = {};
  ridesInSession.forEach((r) => {
    const uid = r.userId;
    if (!byUser[uid]) byUser[uid] = [];
    byUser[uid].push(r);
  });
  const userCount = Object.keys(byUser).length;
  const result = {};
  if (userCount < 2) {
    ridesInSession.forEach((r) => { result[String(r._id || r.id)] = null; });
    return result;
  }

  for (const ride of ridesInSession) {
    const rid = String(ride._id || ride.id);
    const selfTele = telemetryByRideId[rid];
    const selfPoly = polyByRideId[rid];
    if (!selfTele || !selfPoly || !selfTele.timestamp || selfTele.timestamp.length < 2) {
      result[rid] = null;
      continue;
    }
    const ts = selfTele.timestamp;
    const rideStart = ts[0];
    const rideEnd = ts[ts.length - 1];
    if (rideEnd - rideStart < FORK_SUSTAINED_MS) {
      result[rid] = null;
      continue;
    }

    const span = rideEnd - rideStart;
    const numSamples = Math.max(2, Math.floor(span / FORK_SAMPLE_INTERVAL_MS));
    const sampleTimes = new Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      sampleTimes[i] = rideStart + Math.floor((i * span) / (numSamples - 1));
    }

    const distArr = new Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const t = sampleTimes[i];
      const selfPos = memberPositionAtTime(selfTele, selfPoly.points, selfPoly.cumDist, t);
      if (!selfPos) { distArr[i] = NaN; continue; }
      const others = [];
      for (const [uid, userRides] of Object.entries(byUser)) {
        if (uid === ride.userId) continue;
        for (const other of userRides) {
          const oid = String(other._id || other.id);
          const oTele = telemetryByRideId[oid];
          const oPoly = polyByRideId[oid];
          if (!oTele || !oPoly) continue;
          const p = memberPositionAtTime(oTele, oPoly.points, oPoly.cumDist, t);
          if (p) { others.push(p); break; }
        }
      }
      if (others.length === 0) { distArr[i] = NaN; continue; }
      let sumLat = 0;
      let sumLng = 0;
      others.forEach(([la, ln]) => { sumLat += la; sumLng += ln; });
      const cLat = sumLat / others.length;
      const cLng = sumLng / others.length;
      distArr[i] = distanceMeters(selfPos[0], selfPos[1], cLat, cLng);
    }

    let lastInRange = -1;
    for (let i = numSamples - 1; i >= 0; i--) {
      const d = distArr[i];
      if (!Number.isNaN(d) && d <= FORK_RADIUS_M) { lastInRange = i; break; }
    }
    if (lastInRange < 0 || lastInRange >= numSamples - 1) { result[rid] = null; continue; }
    const cutoff = sampleTimes[lastInRange];
    result[rid] = rideEnd - cutoff >= FORK_SUSTAINED_MS ? cutoff : null;
  }
  return result;
}

// ── Trim helpers ───────────────────────────────────────────────────
function trimPolylineAtTime(tele, points, polyCumDist, cutoffMs) {
  const ts = tele.timestamp;
  const cum = tele.cumDistanceM;
  if (points.length < 2 || polyCumDist.length < 2 || !cum || cum.length === 0) return points;
  if (!ts || ts.length === 0) return points;
  const cutoff = Math.max(ts[0], Math.min(ts[ts.length - 1], cutoffMs));
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= cutoff) lo = mid;
    else hi = mid;
  }
  const idx = Math.max(0, Math.min(cum.length - 1, lo));
  const targetCumDist = cum[idx];
  let splitIdx = polyCumDist.findIndex((v) => v >= targetCumDist);
  if (splitIdx < 0) splitIdx = points.length - 1;
  splitIdx = Math.min(points.length, splitIdx + 1);
  return splitIdx >= 2 ? points.slice(0, splitIdx) : points;
}

function trimTelemetryAtTime(tele, cutoffMs) {
  const ts = tele.timestamp || [];
  if (ts.length === 0) return tele;
  if (cutoffMs >= ts[ts.length - 1]) return tele;
  if (cutoffMs <= ts[0]) {
    return {
      ...tele,
      speed: [],
      gForce: [],
      leanAngle: [],
      timestamp: [],
      cumDistanceM: [],
    };
  }
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= cutoffMs) lo = mid;
    else hi = mid;
  }
  const endIdx = lo + 1; // exclusive
  const cut = (a) => (Array.isArray(a) ? a.slice(0, endIdx) : a);
  return {
    ...tele,
    speed: cut(tele.speed),
    gForce: cut(tele.gForce),
    leanAngle: cut(tele.leanAngle),
    timestamp: cut(tele.timestamp),
    cumDistanceM: cut(tele.cumDistanceM),
  };
}

/**
 * High-level helper: given the raw rides + telemetries for a group ride,
 * returns per-ride { sessionNumber, trimmedEncodedPolyline, trimmedTelemetry, cutoffMs }.
 *
 * Rides not assigned to any session (phantom) get sessionNumber=null and
 * no trimming (returns originals).
 */
function buildGroupRideTrim(rides, telemetries) {
  const teleByRideId = {};
  for (const t of telemetries) {
    if (t.rideId) teleByRideId[String(t.rideId)] = t;
  }
  const polyByRideId = {};
  for (const r of rides) {
    const rid = String(r._id || r.id);
    const points = decodePolyline(r.encodedPolyline || '');
    polyByRideId[rid] = { points, cumDist: polylineCumDist(points) };
  }

  const { sessions, rideToSession } = clusterRidesIntoSessions(rides);

  // Compute fork cutoffs per session
  const cutoffByRide = {};
  rides.forEach((r) => { cutoffByRide[String(r._id || r.id)] = null; });
  for (const session of sessions) {
    const ridesInSession = rides.filter((r) =>
      session.rideIds.includes(String(r._id || r.id))
    );
    const cutoffs = computeForkCutoffs(ridesInSession, teleByRideId, polyByRideId);
    Object.assign(cutoffByRide, cutoffs);
  }

  const perRide = {};
  for (const r of rides) {
    const rid = String(r._id || r.id);
    const sessionNumber = rideToSession[rid] || null;
    const cutoff = cutoffByRide[rid];
    const tele = teleByRideId[rid];
    const poly = polyByRideId[rid];
    if (cutoff != null && tele && poly && poly.points.length >= 2) {
      const trimmedPoints = trimPolylineAtTime(tele, poly.points, poly.cumDist, cutoff);
      const trimmedTele = trimTelemetryAtTime(tele, cutoff);
      perRide[rid] = {
        sessionNumber,
        cutoffMs: cutoff,
        groupEncodedPolyline: encodePolyline(trimmedPoints),
        groupTelemetry: trimmedTele,
      };
    } else {
      perRide[rid] = {
        sessionNumber,
        cutoffMs: null,
        groupEncodedPolyline: r.encodedPolyline || '',
        groupTelemetry: tele || null,
      };
    }
  }
  return { sessions, perRide };
}

module.exports = {
  decodePolyline,
  encodePolyline,
  polylineCumDist,
  clusterRidesIntoSessions,
  computeForkCutoffs,
  trimPolylineAtTime,
  trimTelemetryAtTime,
  buildGroupRideTrim,
  // Constants (exposed for tests / debugging)
  PHANTOM_MIN_DISTANCE_M,
  PHANTOM_MIN_AVG_SPEED_MPS,
  SESSION_GAP_MS,
  FORK_RADIUS_M,
  FORK_SUSTAINED_MS,
  FORK_SAMPLE_INTERVAL_MS,
};
