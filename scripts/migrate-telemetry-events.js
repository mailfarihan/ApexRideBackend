/**
 * MongoDB Migration Script
 * 
 * Migrates rides collection:
 * 1. Telemetry timestamps: relative ms (from startTime) → absolute unix ms
 * 2. Events: rename speedAtEvent → speed, add leanAngle & gForce defaults
 * 
 * Usage:
 *   mongosh "mongodb+srv://..." migrate-telemetry-events.js
 *   OR
 *   node migrate-telemetry-events.js <MONGODB_URI>
 * 
 * Run with DRY_RUN=true to preview changes without writing.
 */

const DRY_RUN = process.env.DRY_RUN === 'true';

async function migrate(db) {
  const rides = db.collection('rides');
  const cursor = rides.find({});
  
  let total = 0;
  let telemetryUpdated = 0;
  let eventsUpdated = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const ride = await cursor.next();
    total++;

    const updates = {};
    let needsUpdate = false;

    // --- 1. Convert telemetry timestamps from relative to absolute ---
    if (ride.telemetry?.timestamp?.length > 0 && ride.startTime) {
      // Heuristic: if the first timestamp is much smaller than startTime,
      // it's still relative (e.g. 0, 1000, 2000 vs 1700000000000)
      const firstTs = ride.telemetry.timestamp[0];
      const isRelative = firstTs < 1_000_000_000_000; // < year 2001 in unix ms

      if (isRelative) {
        const absoluteTimestamps = ride.telemetry.timestamp.map(
          t => t + ride.startTime
        );
        updates['telemetry.timestamp'] = absoluteTimestamps;
        telemetryUpdated++;
        needsUpdate = true;
      }
    }

    // --- 2. Migrate events: speedAtEvent → speed, add leanAngle/gForce ---
    if (ride.events?.length > 0) {
      const hasOldField = ride.events.some(e => e.speedAtEvent !== undefined);
      if (hasOldField) {
        const migratedEvents = ride.events.map(e => {
          const migrated = { ...e };
          if (migrated.speedAtEvent !== undefined) {
            // speedAtEvent was in m/s from Android location.speed, convert to km/h
            migrated.speed = migrated.speedAtEvent * 3.6;
            delete migrated.speedAtEvent;
          }
          if (migrated.leanAngle === undefined) migrated.leanAngle = 0;
          if (migrated.gForce === undefined) migrated.gForce = 0;
          return migrated;
        });
        updates.events = migratedEvents;
        eventsUpdated++;
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would update ride ${ride._id} (startTime: ${ride.startTime})`);
      } else {
        await rides.updateOne({ _id: ride._id }, { $set: updates });
      }
    } else {
      skipped++;
    }
  }

  console.log('\n--- Migration Summary ---');
  console.log(`Total rides scanned: ${total}`);
  console.log(`Telemetry timestamps converted: ${telemetryUpdated}`);
  console.log(`Events migrated: ${eventsUpdated}`);
  console.log(`Skipped (already migrated): ${skipped}`);
  if (DRY_RUN) console.log('(DRY RUN - no changes written)');
}

// --- Entry point ---
if (typeof db !== 'undefined') {
  // Running inside mongosh
  migrate(db).then(() => console.log('Done.'));
} else {
  // Running with Node.js
  const { MongoClient } = require('mongodb');
  const uri = process.argv[2] || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Usage: node migrate-telemetry-events.js <MONGODB_URI>');
    console.error('  or set MONGODB_URI environment variable');
    process.exit(1);
  }
  const client = new MongoClient(uri);
  client.connect()
    .then(() => migrate(client.db()))
    .then(() => client.close())
    .then(() => console.log('Done.'))
    .catch(err => { console.error(err); process.exit(1); });
}
