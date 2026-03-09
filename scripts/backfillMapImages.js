/**
 * One-time backfill script: Generate static map images for Rides and Routes
 * that are missing them.
 *
 * For each record without mapImageLightUrl:
 *   1. Use encodedPolyline if available
 *   2. Otherwise, fall back to routePointsJson (Rides only) and encode it
 *   3. For Trips/GroupRides with meetupLocation, generate point-based images
 *
 * Usage:
 *   node scripts/backfillMapImages.js
 *
 * Required env vars (set in .env or export):
 *   MONGODB_URI
 *   GOOGLE_STATIC_MAPS_API_KEY
 *   FIREBASE_SERVICE_ACCOUNT  (or FIREBASE_PROJECT_ID)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const admin = require('firebase-admin');

// --- Firebase Admin init (same as auth.js) ---
const projectId = process.env.FIREBASE_PROJECT_ID || 'apexride-9bdff';
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    storageBucket: `${projectId}.firebasestorage.app`
  });
} else {
  admin.initializeApp({
    projectId,
    storageBucket: `${projectId}.firebasestorage.app`
  });
}

const Ride = require('../src/models/Ride');
const Route = require('../src/models/Route');
const Trip = require('../src/models/Trip');
const { generateMapImages, generateMapImagesForPoint } = require('../src/services/mapImage');

// ---------------------------------------------------------------------------
// Google Encoded Polyline Algorithm
// https://developers.google.com/maps/documentation/utilities/polylinealgorithm
// ---------------------------------------------------------------------------
function encodePolyline(points) {
  let encoded = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const pt of points) {
    const lat = Math.round(pt.latitude * 1e5);
    const lng = Math.round(pt.longitude * 1e5);

    encoded += encodeSignedValue(lat - prevLat);
    encoded += encodeSignedValue(lng - prevLng);

    prevLat = lat;
    prevLng = lng;
  }
  return encoded;
}

function encodeSignedValue(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let encoded = '';
  while (v >= 0x20) {
    encoded += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  encoded += String.fromCharCode(v + 63);
  return encoded;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a usable encoded polyline from a Ride document.
 * Prefers encodedPolyline, falls back to routePointsJson.
 */
function getPolylineForRide(ride) {
  if (ride.encodedPolyline && ride.encodedPolyline.length > 0) {
    return ride.encodedPolyline;
  }

  // Fall back to routePointsJson
  if (ride.routePointsJson && ride.routePointsJson !== '[]') {
    try {
      const points = JSON.parse(ride.routePointsJson);
      if (Array.isArray(points) && points.length >= 2) {
        return encodePolyline(points);
      }
    } catch (e) {
      // bad JSON, skip
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is required');
    process.exit(1);
  }
  if (!process.env.GOOGLE_STATIC_MAPS_API_KEY) {
    console.error('❌ GOOGLE_STATIC_MAPS_API_KEY is required');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  // --- Rides ---
  const rides = await Ride.find({
    $or: [
      { mapImageLightUrl: { $exists: false } },
      { mapImageLightUrl: '' },
      { mapImageLightUrl: null }
    ]
  }).lean();

  console.log(`\n🏍️  Found ${rides.length} rides without map images`);

  let rideOk = 0, rideSkip = 0;
  for (const ride of rides) {
    const polyline = getPolylineForRide(ride);
    if (!polyline) {
      rideSkip++;
      continue;
    }

    try {
      const { mapImageLightUrl, mapImageDarkUrl } = await generateMapImages(polyline, 'ride');
      if (mapImageLightUrl) {
        await Ride.updateOne({ _id: ride._id }, { mapImageLightUrl, mapImageDarkUrl });
        rideOk++;
        process.stdout.write(`  ✅ Ride ${ride._id} (localId: ${ride.localId})\n`);
      } else {
        rideSkip++;
        process.stdout.write(`  ⚠️  Ride ${ride._id} – API returned empty\n`);
      }
    } catch (err) {
      rideSkip++;
      process.stdout.write(`  ❌ Ride ${ride._id} – ${err.message}\n`);
    }

    // Throttle to avoid rate limits (2 images per record = 2 API calls)
    await sleep(500);
  }
  console.log(`   Rides done: ${rideOk} generated, ${rideSkip} skipped\n`);

  // --- Routes ---
  const routes = await Route.find({
    $or: [
      { mapImageLightUrl: { $exists: false } },
      { mapImageLightUrl: '' },
      { mapImageLightUrl: null }
    ]
  }).lean();

  console.log(`🗺️  Found ${routes.length} routes without map images`);

  let routeOk = 0, routeSkip = 0;
  for (const route of routes) {
    const polyline = route.encodedPolyline && route.encodedPolyline.length > 0
      ? route.encodedPolyline
      : null;

    if (!polyline) {
      routeSkip++;
      continue;
    }

    try {
      const { mapImageLightUrl, mapImageDarkUrl } = await generateMapImages(polyline, 'route');
      if (mapImageLightUrl) {
        await Route.updateOne({ _id: route._id }, { mapImageLightUrl, mapImageDarkUrl });
        routeOk++;
        process.stdout.write(`  ✅ Route ${route._id} "${route.title}"\n`);
      } else {
        routeSkip++;
        process.stdout.write(`  ⚠️  Route ${route._id} – API returned empty\n`);
      }
    } catch (err) {
      routeSkip++;
      process.stdout.write(`  ❌ Route ${route._id} – ${err.message}\n`);
    }

    await sleep(500);
  }
  console.log(`   Routes done: ${routeOk} generated, ${routeSkip} skipped\n`);

  // --- Trips / GroupRides ---
  const trips = await Trip.find({
    $or: [
      { mapImageLightUrl: { $exists: false } },
      { mapImageLightUrl: '' },
      { mapImageLightUrl: null }
    ]
  }).lean();

  console.log(`📍 Found ${trips.length} trips/group rides without map images`);

  let tripOk = 0, tripSkip = 0;
  for (const trip of trips) {
    const coords = trip.meetupLocation && trip.meetupLocation.coordinates;
    if (!coords || coords.length < 2) {
      tripSkip++;
      continue;
    }

    const [lng, lat] = coords; // GeoJSON is [lng, lat]

    try {
      const { mapImageLightUrl, mapImageDarkUrl } = await generateMapImagesForPoint(lat, lng, 'trip');
      if (mapImageLightUrl) {
        await Trip.updateOne({ _id: trip._id }, { mapImageLightUrl, mapImageDarkUrl });
        tripOk++;
        process.stdout.write(`  ✅ Trip ${trip._id} "${trip.title}"\n`);
      } else {
        tripSkip++;
        process.stdout.write(`  ⚠️  Trip ${trip._id} – API returned empty\n`);
      }
    } catch (err) {
      tripSkip++;
      process.stdout.write(`  ❌ Trip ${trip._id} – ${err.message}\n`);
    }

    await sleep(500);
  }
  console.log(`   Trips done: ${tripOk} generated, ${tripSkip} skipped\n`);

  // --- Summary ---
  console.log('━'.repeat(50));
  console.log(`📊 Summary:`);
  console.log(`   Rides:  ${rideOk} generated, ${rideSkip} skipped (of ${rides.length})`);
  console.log(`   Routes: ${routeOk} generated, ${routeSkip} skipped (of ${routes.length})`);
  console.log(`   Trips:  ${tripOk} generated, ${tripSkip} skipped (of ${trips.length})`);
  console.log('━'.repeat(50));

  await mongoose.disconnect();
  console.log('\n✅ Done – disconnected from MongoDB');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
