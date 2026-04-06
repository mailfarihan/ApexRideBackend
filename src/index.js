require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Check required env vars
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is required');
  process.exit(1);
}

// Load routes after env check
const authMiddleware = require('./middleware/auth');

const routesRouter = require('./routes/routes');
const ridesRouter = require('./routes/rides');
const tripsRouter = require('./routes/trips');
const usersRouter = require('./routes/users');
const telemetryRouter = require('./routes/telemetry');

// Auth routes (no middleware - used for sign-in sync)


// Public routes (no auth required)
const Trip = require('./models/Trip');
const User = require('./models/User');

// GET /api/trips/:id/invite — Public invite endpoint for share links
app.get('/api/trips/:id/invite', async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id)
      .select('title description startAddress dateTime status creatorId creatorName creatorPhotoUrl attendeeIds ridingStyles estimatedDistance linkedRouteId maxRiders mapImageDarkUrl extraInfo')
      .lean();

    if (!trip) {
      return res.status(404).json({ error: 'Group ride not found' });
    }

    // Fetch participant display names + photos
    const allUserIds = [trip.creatorId, ...(trip.attendeeIds || [])];
    const users = await User.find({ firebaseUid: { $in: allUserIds } })
      .select('firebaseUid displayName photoUrl')
      .lean();

    const userMap = {};
    for (const u of users) {
      userMap[u.firebaseUid] = { displayName: u.displayName || 'Rider', photoUrl: u.photoUrl || '' };
    }

    const participants = (trip.attendeeIds || []).map(uid => ({
      displayName: userMap[uid]?.displayName || 'Rider',
      photoUrl: userMap[uid]?.photoUrl || ''
    }));

    res.json({
      id: trip._id,
      title: trip.title,
      description: trip.description,
      startAddress: trip.startAddress,
      dateTime: trip.dateTime,
      status: trip.status,
      creatorName: trip.creatorName,
      creatorPhotoUrl: userMap[trip.creatorId]?.photoUrl || trip.creatorPhotoUrl || '',
      attendeeCount: (trip.attendeeIds || []).length,
      maxRiders: trip.maxRiders || 0,
      ridingStyles: trip.ridingStyles || [],
      estimatedDistance: trip.estimatedDistance,
      mapImageDarkUrl: trip.mapImageDarkUrl || '',
      extraInfo: trip.extraInfo || '',
      participants
    });
  } catch (error) {
    console.error('Invite endpoint error:', error);
    res.status(500).json({ error: 'Failed to load group ride' });
  }
});

// GET /ride — Server-side rendered ride page with dynamic OG tags + interactive map
app.get('/ride', async (req, res) => {
  const rideId = req.query.id;
  if (!rideId) {
    return res.redirect('https://apexride.dev');
  }

  try {
    const trip = await Trip.findById(rideId)
      .select('title description startAddress dateTime status creatorId creatorName creatorPhotoUrl attendeeIds ridingStyles estimatedDistance linkedRouteId maxRiders mapImageDarkUrl startLocation endLocation')
      .lean();

    if (!trip) {
      return res.redirect('https://apexride.dev');
    }

    // Fetch linked route for polyline
    let encodedPolyline = '';
    if (trip.linkedRouteId) {
      const Route = require('./models/Route');
      const route = await Route.findById(trip.linkedRouteId).select('encodedPolyline').lean();
      if (route) encodedPolyline = route.encodedPolyline || '';
    }

    // Fetch participant info
    const allUserIds = [trip.creatorId, ...(trip.attendeeIds || [])];
    const users = await User.find({ firebaseUid: { $in: allUserIds } })
      .select('firebaseUid displayName photoUrl')
      .lean();
    const userMap = {};
    for (const u of users) {
      userMap[u.firebaseUid] = { displayName: u.displayName || 'Rider', photoUrl: u.photoUrl || '' };
    }

    const creatorName = userMap[trip.creatorId]?.displayName || trip.creatorName || 'Rider';
    const attendeeCount = (trip.attendeeIds || []).length;
    const dateObj = new Date(trip.dateTime);
    const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const locationLine = trip.startAddress ? `&#10;&#10;📍 ${trip.startAddress}` : '';
    const ogDescription = `&#10;📅 ${dateStr}${locationLine}`;

    const participants = (trip.attendeeIds || []).map(uid => ({
      displayName: userMap[uid]?.displayName || 'Rider',
      photoUrl: userMap[uid]?.photoUrl || ''
    }));

    const startLat = trip.startLocation?.coordinates?.[1] || 0;
    const startLng = trip.startLocation?.coordinates?.[0] || 0;

    // Escape for safe HTML embedding
    const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(trip.title)} — ApexRide Group Ride</title>
<meta property="og:title" content="${esc(trip.title)}">
<meta property="og:description" content="${esc(ogDescription).replace(/\n/g, '&#10;')}">
<meta property="og:url" content="https://apexride.dev/ride?id=${esc(rideId)}">
<meta property="og:image" content="${esc(trip.mapImageDarkUrl || 'https://apexride.dev/images/screenshot-map.jpeg')}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ApexRide">
<link rel="icon" type="image/png" href="https://apexride.dev/images/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--surface:#141418;--surface-hover:#1c1c22;--border:#28282f;--text:#f0f0f4;--text-muted:#8c8c9e;--accent:#f57c00;--accent-light:#ffb74d;--gradient:linear-gradient(135deg,#ff9800 0%,#f4511e 100%)}
html{scroll-behavior:smooth}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh;display:flex;flex-direction:column}
nav{background:rgba(10,10,15,.88);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:.75rem 1.5rem}
.nav-inner{max-width:680px;margin:0 auto;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:center;gap:.6rem;font-weight:800;font-size:1.2rem;text-decoration:none;color:var(--text)}
.logo img{width:34px;height:34px;border-radius:8px}
.logo span{color:var(--accent-light)}
.container{max-width:680px;margin:0 auto;padding:2rem 1.5rem;flex:1}
.ride-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden}
#map{width:100%;height:220px;border-bottom:1px solid var(--border);background:var(--bg)}
.ride-header{padding:1.5rem;border-bottom:1px solid var(--border)}
.ride-status{display:inline-block;padding:.2rem .6rem;border-radius:6px;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.75rem}
.status-upcoming{background:rgba(76,175,80,.15);color:#66bb6a}
.status-ongoing{background:rgba(245,124,0,.15);color:var(--accent-light)}
.status-completed{background:rgba(158,158,158,.15);color:#9e9e9e}
.status-cancelled{background:rgba(244,67,54,.15);color:#ef5350}
.ride-title{font-size:1.5rem;font-weight:700;letter-spacing:-.3px;margin-bottom:.25rem}
.ride-creator{color:var(--text-muted);font-size:.9rem;display:flex;align-items:center;gap:.5rem}
.ride-creator img{width:20px;height:20px;border-radius:50%;object-fit:cover}
.ride-body{padding:1.5rem}
.ride-meta{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.25rem}
.meta-item{display:flex;align-items:flex-start;gap:.5rem}
.meta-icon{width:18px;height:18px;color:var(--accent);flex-shrink:0;margin-top:2px}
.meta-label{font-size:.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.3px}
.meta-value{font-size:.95rem;font-weight:500}
.ride-description{color:var(--text-muted);font-size:.95rem;margin-bottom:1.25rem;line-height:1.7}
.tags{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1.25rem}
.tag{background:var(--surface-hover);border:1px solid var(--border);padding:.2rem .6rem;border-radius:6px;font-size:.8rem;color:var(--text-muted)}
.members-section{border-top:1px solid var(--border);padding:1.25rem 1.5rem}
.members-title{font-size:.85rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:.75rem}
.members-list{display:flex;flex-wrap:wrap;gap:.75rem}
.member{display:flex;align-items:center;gap:.5rem;background:var(--surface-hover);padding:.35rem .7rem;border-radius:20px;font-size:.85rem}
.member img{width:24px;height:24px;border-radius:50%;object-fit:cover}
.member-placeholder{width:24px;height:24px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:.7rem;color:var(--text-muted)}
.cta-section{padding:1.5rem;border-top:1px solid var(--border);text-align:center}
.cta-btn{display:inline-flex;align-items:center;gap:.5rem;padding:.85rem 2rem;background:var(--gradient);color:#fff;font-weight:600;font-size:1rem;border:none;border-radius:12px;text-decoration:none;cursor:pointer;transition:transform .15s,box-shadow .15s}
.cta-btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(245,124,0,.2)}
.cta-btn svg{width:20px;height:20px}
.cta-sub{margin-top:.75rem;font-size:.85rem;color:var(--text-muted)}
.cta-sub a{color:var(--accent-light);text-decoration:none}
.cta-ended{color:var(--text-muted);font-size:.95rem;padding:.5rem 0}
footer{text-align:center;padding:1.5rem;color:var(--text-muted);font-size:.8rem;border-top:1px solid var(--border)}
@media(max-width:500px){.ride-meta{grid-template-columns:1fr}.ride-title{font-size:1.25rem}}
</style>
</head>
<body>
<nav><div class="nav-inner"><a href="https://apexride.dev" class="logo"><img src="https://apexride.dev/images/icon.png" alt="ApexRide">Apex<span>Ride</span></a></div></nav>
<div class="container">
<div class="ride-card">
<div id="map"></div>
<div class="ride-header">
<div class="ride-status status-${esc(trip.status)}">${esc(trip.status)}</div>
<h1 class="ride-title">${esc(trip.title)}</h1>
<div class="ride-creator">${userMap[trip.creatorId]?.photoUrl ? '<img src="' + esc(userMap[trip.creatorId].photoUrl) + '" alt="">' : ''}Organized by <strong>${esc(creatorName)}</strong></div>
</div>
<div class="ride-body">
<div class="ride-meta">
<div class="meta-item"><svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><div><div class="meta-label">When</div><div class="meta-value">${esc(dateStr)}</div></div></div>
${trip.startAddress ? '<div class="meta-item"><svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg><div><div class="meta-label">Start</div><div class="meta-value">' + esc(trip.startAddress) + '</div></div></div>' : ''}
<div class="meta-item"><svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg><div><div class="meta-label">Riders</div><div class="meta-value">${attendeeCount} rider${attendeeCount !== 1 ? 's' : ''}${trip.maxRiders > 0 ? ' / ' + trip.maxRiders + ' max' : ''}</div></div></div>
${trip.estimatedDistance > 0 ? '<div class="meta-item"><svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="16"/><circle cx="12" cy="19" r="3"/></svg><div><div class="meta-label">Distance</div><div class="meta-value">' + trip.estimatedDistance.toFixed(1) + ' km</div></div></div>' : ''}
</div>
${trip.description ? '<p class="ride-description">' + esc(trip.description) + '</p>' : ''}
${trip.ridingStyles?.length ? '<div class="tags">' + trip.ridingStyles.map(s => '<span class="tag">' + esc(s.replace(/_/g,' ').replace(/\\b\\w/g, c => c.toUpperCase())) + '</span>').join('') + '</div>' : ''}
</div>
<div class="members-section">
<div class="members-title">Riders (${attendeeCount})</div>
<div class="members-list">${participants.map(p => '<div class="member">' + (p.photoUrl ? '<img src="' + esc(p.photoUrl) + '" alt="">' : '<div class="member-placeholder">' + esc((p.displayName || 'R').charAt(0).toUpperCase()) + '</div>') + esc(p.displayName) + '</div>').join('')}</div>
</div>
<div class="cta-section" id="cta-section">
${trip.status === 'completed' || trip.status === 'cancelled'
  ? '<p class="cta-ended">This group ride has ' + (trip.status === 'completed' ? 'already ended.' : 'been cancelled.') + '</p><p class="cta-sub">Get <a href="https://play.google.com/store/apps/details?id=com.apexride">ApexRide</a> to discover upcoming rides.</p>'
  : '<a class="cta-btn" id="open-app-btn" href="#"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>Open in ApexRide</a><p class="cta-sub">Don\'t have the app? <a href="https://play.google.com/store/apps/details?id=com.apexride">Get it on Google Play</a></p>'}
</div>
</div>
</div>
<footer>&copy; 2025 ApexRide. All rights reserved.</footer>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
var rideId = ${JSON.stringify(rideId)};
var startLat = ${startLat};
var startLng = ${startLng};
var encodedPolyline = ${JSON.stringify(encodedPolyline)};

// Deep link setup
var deepLink = 'apexride://group-ride/' + encodeURIComponent(rideId);
var webFallback = 'https://play.google.com/store/apps/details?id=com.apexride';
var intentUrl = 'intent://group-ride/' + encodeURIComponent(rideId) +
  '#Intent;scheme=apexride;package=com.apexride;S.browser_fallback_url=' +
  encodeURIComponent(webFallback) + ';end';

var btn = document.getElementById('open-app-btn');
var isAndroid = /android/i.test(navigator.userAgent);
var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

if (btn) {
  btn.href = isAndroid ? intentUrl : (isIOS ? deepLink : webFallback);
}

// Try custom scheme to open app directly (works from WhatsApp in-app browser)
if (isAndroid) {
  var launched = false;
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) launched = true;
  });
  window.location.href = deepLink;
  setTimeout(function() {
    if (!launched) {
      // App not installed: page stays visible, button falls back to intent://
    }
  }, 1500);
}

// Decode Google encoded polyline
function decodePolyline(encoded) {
  var points = [], index = 0, len = encoded.length;
  var lat = 0, lng = 0;
  while (index < len) {
    var b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// Init map
var map = L.map('map', { zoomControl: false, attributionControl: false });
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19
}).addTo(map);

var orangePin = L.divIcon({
  className: '',
  html: '<svg width="24" height="32" viewBox="0 0 32 42" xmlns="http://www.w3.org/2000/svg"><path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z" fill="#ff9800" stroke="#e65100" stroke-width="1.5"/><circle cx="16" cy="15" r="6" fill="white"/></svg>',
  iconSize: [24, 32],
  iconAnchor: [12, 32]
});

if (encodedPolyline) {
  var coords = decodePolyline(encodedPolyline);
  var polyline = L.polyline(coords, { color: '#ff9800', weight: 3, opacity: 0.9 }).addTo(map);
  L.marker(coords[0], { icon: orangePin }).addTo(map);
  map.fitBounds(polyline.getBounds(), { padding: [30, 30] });
} else if (startLat && startLng) {
  L.marker([startLat, startLng], { icon: orangePin }).addTo(map);
  map.setView([startLat, startLng], 13);
} else {
  map.setView([0, 0], 2);
}
})();
</script>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    res.set('Content-Security-Policy', "default-src 'self'; img-src * data: blob:; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src https://fonts.gstatic.com; connect-src *");
    res.send(html);
  } catch (error) {
    console.error('Ride page error:', error);
    res.redirect('https://apexride.dev');
  }
});

// Protected routes
app.use('/api/routes', authMiddleware, routesRouter);
app.use('/api/rides', authMiddleware, ridesRouter);
app.use('/api/trips', authMiddleware, tripsRouter);
app.use('/api/users', authMiddleware, usersRouter);
app.use('/api/telemetry', authMiddleware, telemetryRouter);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Connect to MongoDB and start server
const PORT = process.env.PORT || 3000;
const purgeDeletedAccounts = require('./cron/purgeDeletedAccounts');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB Atlas');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // Run purge job once on startup, then every 24 hours
    purgeDeletedAccounts();
    setInterval(purgeDeletedAccounts, 24 * 60 * 60 * 1000);
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });
