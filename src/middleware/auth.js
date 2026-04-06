const admin = require('firebase-admin');

// Initialize Firebase Admin (for token verification + storage)
try {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID || 'apexride-9bdff';
    
    // Use service account if available, otherwise project ID only
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: `${projectId}.firebasestorage.app`
      });
    } else {
      admin.initializeApp({
        projectId,
        storageBucket: `${projectId}.firebasestorage.app`
      });
    }
  }
  console.log('✅ Firebase Admin initialized');
} catch (error) {
  console.error('⚠️ Firebase Admin init warning:', error.message);
}

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: decodedToken.name || 'Anonymous',
      picture: decodedToken.picture || ''
    };
    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = authMiddleware;
