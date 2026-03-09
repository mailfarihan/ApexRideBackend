const admin = require('firebase-admin');
const https = require('https');
const crypto = require('crypto');

const STATIC_MAPS_BASE = 'https://maps.googleapis.com/maps/api/staticmap';
const BUCKET_FOLDER = 'map-images';

/**
 * Google Maps dark mode style (silver-dark variant)
 */
const DARK_STYLE = [
  'style=element:geometry|color:0x212121',
  'style=element:labels.icon|visibility:off',
  'style=element:labels.text.fill|color:0x757575',
  'style=element:labels.text.stroke|color:0x212121',
  'style=feature:administrative|element:geometry|color:0x757575',
  'style=feature:administrative.country|element:labels.text.fill|color:0x9e9e9e',
  'style=feature:administrative.locality|element:labels.text.fill|color:0xbdbdbd',
  'style=feature:poi|element:labels.text.fill|color:0x757575',
  'style=feature:poi.park|element:geometry|color:0x181818',
  'style=feature:poi.park|element:labels.text.fill|color:0x616161',
  'style=feature:road|element:geometry.fill|color:0x2c2c2c',
  'style=feature:road|element:labels.text.fill|color:0x8a8a8a',
  'style=feature:road.arterial|element:geometry|color:0x373737',
  'style=feature:road.highway|element:geometry|color:0x3c3c3c',
  'style=feature:road.highway.controlled_access|element:geometry|color:0x4e4e4e',
  'style=feature:transit|element:labels.text.fill|color:0x757575',
  'style=feature:water|element:geometry|color:0x000000',
  'style=feature:water|element:labels.text.fill|color:0x3d3d3d'
].join('&');

/**
 * Build Google Static Maps URL from an encoded polyline
 */
function buildStaticMapUrl(encodedPolyline, isDark, apiKey) {
  const size = '600x300';
  const pathColor = isDark ? '0xFF9800FF' : '0xFF6200EEFF';
  const pathWeight = '4';

  let url = `${STATIC_MAPS_BASE}?size=${size}&scale=2&maptype=roadmap`;
  url += `&path=color:0x${pathColor}|weight:${pathWeight}|enc:${encodedPolyline}`;
  url += `&key=${apiKey}`;

  if (isDark) {
    url += `&${DARK_STYLE}`;
  }

  return url;
}

/**
 * Build Google Static Maps URL from a single point (meetup marker)
 */
function buildStaticMapUrlForPoint(lat, lng, isDark, apiKey) {
  const size = '600x300';
  const markerColor = isDark ? 'orange' : 'red';

  let url = `${STATIC_MAPS_BASE}?size=${size}&scale=2&maptype=roadmap`;
  url += `&center=${lat},${lng}&zoom=14`;
  url += `&markers=color:${markerColor}|${lat},${lng}`;
  url += `&key=${apiKey}`;

  if (isDark) {
    url += `&${DARK_STYLE}`;
  }

  return url;
}

/**
 * Download image from URL and return Buffer
 */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Static Maps API returned status ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Upload a buffer to Firebase Storage and return the public URL
 */
async function uploadToFirebase(buffer, filePath) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(filePath);

  await file.save(buffer, {
    metadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000' // 1 year cache
    }
  });

  // Make publicly readable
  await file.makePublic();

  return `https://storage.googleapis.com/${bucket.name}/${filePath}`;
}

/**
 * Delete a file from Firebase Storage by its public URL
 */
async function deleteFromFirebase(publicUrl) {
  if (!publicUrl) return;

  try {
    const bucket = admin.storage().bucket();
    // Extract file path from URL
    const bucketName = bucket.name;
    const prefix = `https://storage.googleapis.com/${bucketName}/`;
    if (!publicUrl.startsWith(prefix)) return;
    
    const filePath = decodeURIComponent(publicUrl.replace(prefix, ''));
    await bucket.file(filePath).delete();
  } catch (err) {
    // Ignore 404 (already deleted)
    if (err.code !== 404) {
      console.error('Firebase Storage delete error:', err.message);
    }
  }
}

/**
 * Copy a file within Firebase Storage to a new path and return the new public URL
 */
async function copyInFirebase(sourceUrl, destPath) {
  if (!sourceUrl) return null;

  try {
    const bucket = admin.storage().bucket();
    const bucketName = bucket.name;
    const prefix = `https://storage.googleapis.com/${bucketName}/`;
    if (!sourceUrl.startsWith(prefix)) return null;

    const sourcePath = decodeURIComponent(sourceUrl.replace(prefix, ''));
    const sourceFile = bucket.file(sourcePath);
    const destFile = bucket.file(destPath);

    await sourceFile.copy(destFile);
    await destFile.makePublic();

    return `https://storage.googleapis.com/${bucketName}/${destPath}`;
  } catch (err) {
    console.error('Firebase Storage copy error:', err.message);
    return null;
  }
}

/**
 * Generate a unique file name
 */
function generateFileName(prefix) {
  const id = crypto.randomBytes(8).toString('hex');
  return `${BUCKET_FOLDER}/${prefix}_${id}`;
}

/**
 * Generate light and dark map images from encoded polyline, upload to Firebase
 * Returns { mapImageLightUrl, mapImageDarkUrl }
 */
async function generateMapImages(encodedPolyline, prefix = 'ride') {
  const apiKey = process.env.GOOGLE_STATIC_MAPS_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GOOGLE_STATIC_MAPS_API_KEY not set, skipping map image generation');
    return { mapImageLightUrl: '', mapImageDarkUrl: '' };
  }

  if (!encodedPolyline || encodedPolyline.length === 0) {
    return { mapImageLightUrl: '', mapImageDarkUrl: '' };
  }

  try {
    const baseName = generateFileName(prefix);

    // Generate both light and dark in parallel
    const [lightBuffer, darkBuffer] = await Promise.all([
      downloadImage(buildStaticMapUrl(encodedPolyline, false, apiKey)),
      downloadImage(buildStaticMapUrl(encodedPolyline, true, apiKey))
    ]);

    // Upload both in parallel
    const [mapImageLightUrl, mapImageDarkUrl] = await Promise.all([
      uploadToFirebase(lightBuffer, `${baseName}_light.png`),
      uploadToFirebase(darkBuffer, `${baseName}_dark.png`)
    ]);

    return { mapImageLightUrl, mapImageDarkUrl };
  } catch (err) {
    console.error('Map image generation error:', err.message);
    return { mapImageLightUrl: '', mapImageDarkUrl: '' };
  }
}

/**
 * Generate light and dark map images from a single coordinate point
 * Returns { mapImageLightUrl, mapImageDarkUrl }
 */
async function generateMapImagesForPoint(lat, lng, prefix = 'point') {
  const apiKey = process.env.GOOGLE_STATIC_MAPS_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GOOGLE_STATIC_MAPS_API_KEY not set, skipping map image generation');
    return { mapImageLightUrl: '', mapImageDarkUrl: '' };
  }

  try {
    const baseName = generateFileName(prefix);

    const [lightBuffer, darkBuffer] = await Promise.all([
      downloadImage(buildStaticMapUrlForPoint(lat, lng, false, apiKey)),
      downloadImage(buildStaticMapUrlForPoint(lat, lng, true, apiKey))
    ]);

    const [mapImageLightUrl, mapImageDarkUrl] = await Promise.all([
      uploadToFirebase(lightBuffer, `${baseName}_light.png`),
      uploadToFirebase(darkBuffer, `${baseName}_dark.png`)
    ]);

    return { mapImageLightUrl, mapImageDarkUrl };
  } catch (err) {
    console.error('Map image generation for point error:', err.message);
    return { mapImageLightUrl: '', mapImageDarkUrl: '' };
  }
}

/**
 * Copy existing map images to new names (e.g. when publishing ride as route)
 * Returns { mapImageLightUrl, mapImageDarkUrl }
 */
async function copyMapImages(sourceLightUrl, sourceDarkUrl, prefix = 'copy') {
  try {
    const baseName = generateFileName(prefix);

    const [mapImageLightUrl, mapImageDarkUrl] = await Promise.all([
      copyInFirebase(sourceLightUrl, `${baseName}_light.png`),
      copyInFirebase(sourceDarkUrl, `${baseName}_dark.png`)
    ]);

    return {
      mapImageLightUrl: mapImageLightUrl || '',
      mapImageDarkUrl: mapImageDarkUrl || ''
    };
  } catch (err) {
    console.error('Copy map images error:', err.message);
    return { mapImageLightUrl: '', mapImageDarkUrl: '' };
  }
}

/**
 * Delete both light and dark map images
 */
async function deleteMapImages(lightUrl, darkUrl) {
  await Promise.all([
    deleteFromFirebase(lightUrl),
    deleteFromFirebase(darkUrl)
  ]);
}

module.exports = {
  generateMapImages,
  generateMapImagesForPoint,
  copyMapImages,
  deleteMapImages
};
