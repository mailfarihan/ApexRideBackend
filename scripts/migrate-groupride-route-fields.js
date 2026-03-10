/**
 * MongoDB Migration Script — GroupRide & Route field rename/defaults
 *
 * GroupRide (trips collection):
 *   - Rename meetupLocation → startLocation
 *   - Rename meetupAddress → startAddress
 *   - Add endLocation: null, endAddress: "" if missing
 *
 * Route (routes collection):
 *   - Add startAddress: "" if missing
 *   - Add endAddress: "" if missing
 *
 * Usage:
 *   node migrate-groupride-route-fields.js <MONGODB_URI>
 *
 * Run with DRY_RUN=true to preview changes without writing.
 */

// Fix Node.js DNS resolution issues (use Google Public DNS)
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const DRY_RUN = process.env.DRY_RUN === 'true';

async function migrateTrips(db) {
  const trips = db.collection('trips');
  
  // Rename meetupLocation → startLocation, meetupAddress → startAddress
  const filter = { meetupLocation: { $exists: true } };
  const count = await trips.countDocuments(filter);
  console.log(`\nTrips with meetupLocation: ${count}`);

  if (count > 0) {
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would rename meetupLocation→startLocation and meetupAddress→startAddress on ${count} trips`);
    } else {
      const result = await trips.updateMany(filter, {
        $rename: {
          'meetupLocation': 'startLocation',
          'meetupAddress': 'startAddress'
        }
      });
      console.log(`Renamed fields on ${result.modifiedCount} trips`);
    }
  }

  // Add endLocation/endAddress defaults where missing
  const missingEnd = await trips.countDocuments({ endLocation: { $exists: false } });
  console.log(`Trips missing endLocation: ${missingEnd}`);

  if (missingEnd > 0) {
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would add endLocation=null, endAddress="" to ${missingEnd} trips`);
    } else {
      const result = await trips.updateMany(
        { endLocation: { $exists: false } },
        { $set: { endLocation: null, endAddress: '' } }
      );
      console.log(`Added end fields to ${result.modifiedCount} trips`);
    }
  }
}

async function migrateRoutes(db) {
  const routes = db.collection('routes');

  // Add startAddress where missing
  const missingStart = await routes.countDocuments({ startAddress: { $exists: false } });
  console.log(`\nRoutes missing startAddress: ${missingStart}`);

  if (missingStart > 0) {
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would add startAddress="" to ${missingStart} routes`);
    } else {
      const result = await routes.updateMany(
        { startAddress: { $exists: false } },
        { $set: { startAddress: '' } }
      );
      console.log(`Added startAddress to ${result.modifiedCount} routes`);
    }
  }

  // Add endAddress where missing
  const missingEnd = await routes.countDocuments({ endAddress: { $exists: false } });
  console.log(`Routes missing endAddress: ${missingEnd}`);

  if (missingEnd > 0) {
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would add endAddress="" to ${missingEnd} routes`);
    } else {
      const result = await routes.updateMany(
        { endAddress: { $exists: false } },
        { $set: { endAddress: '' } }
      );
      console.log(`Added endAddress to ${result.modifiedCount} routes`);
    }
  }
}

async function migrate(db) {
  await migrateTrips(db);
  await migrateRoutes(db);
  console.log('\n--- Migration Complete ---');
  if (DRY_RUN) console.log('(DRY RUN - no changes written)');
}

// --- Entry point ---
const mongoose = require('mongoose');
const uri = process.argv[2] || process.env.MONGODB_URI;
if (!uri) {
  console.error('Usage: node migrate-groupride-route-fields.js <MONGODB_URI>');
  process.exit(1);
}
mongoose.connect(uri)
  .then(() => migrate(mongoose.connection.db))
  .then(() => mongoose.disconnect())
  .then(() => console.log('Done.'))
  .catch(err => { console.error(err); process.exit(1); });
