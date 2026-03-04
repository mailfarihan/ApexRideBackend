# ApexRide Backend API

Node.js + Express + MongoDB Atlas backend for the ApexRide motorcycle tracking app.

## Features

- **Routes API** - Discover and share motorcycle routes with geo-queries
- **Rides API** - Sync user rides from the mobile app
- **Trips API** - Plan and join group rides

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` file:
   ```env
   MONGODB_URI=mongodb+srv://...
   PORT=3000
   FIREBASE_PROJECT_ID=apexride-9bdff
   ```

3. Run development server:
   ```bash
   npm run dev
   ```

## API Endpoints

### Routes
- `GET /api/routes/nearby?lat=&lng=&radiusKm=` - Find nearby routes
- `POST /api/routes` - Create a route
- `POST /api/routes/:id/rate` - Rate a route
- `DELETE /api/routes/:id` - Delete your route

### Rides
- `GET /api/rides` - Get your synced rides
- `POST /api/rides` - Sync a single ride
- `POST /api/rides/sync` - Batch sync rides
- `DELETE /api/rides/:localId` - Delete a synced ride

### Trips
- `GET /api/trips` - Get your planned trips
- `GET /api/trips/nearby?lat=&lng=` - Find nearby upcoming trips
- `POST /api/trips` - Create a trip
- `POST /api/trips/:id/join` - Join a trip
- `POST /api/trips/:id/leave` - Leave a trip
- `DELETE /api/trips/:id` - Delete your trip

## Deployment

Deploy to Render using the included `render.yaml` configuration.

Set the `MONGODB_URI` environment variable in Render dashboard.
