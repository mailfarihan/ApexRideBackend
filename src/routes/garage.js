const express = require('express');
const router = express.Router();
const Bike = require('../models/Bike');

function dto(b) {
  return {
    id: b._id.toString(),
    userId: b.userId,
    make: b.make,
    model: b.model,
    year: b.year || null,
    displacement: b.displacement || null,
    nickname: b.nickname || '',
    photoUrl: b.photoUrl || '',
    isPrimary: !!b.isPrimary,
    createdAt: b.createdAt ? new Date(b.createdAt).getTime() : 0
  };
}

// GET /api/garage — list caller's bikes
router.get('/', async (req, res) => {
  try {
    const bikes = await Bike.find({ userId: req.user.uid })
      .sort({ isPrimary: -1, createdAt: -1 })
      .lean();
    res.json({ items: bikes.map(dto) });
  } catch (e) {
    console.error('garage list', e);
    res.status(500).json({ error: 'Failed to load garage' });
  }
});

// GET /api/garage/user/:uid — public list of someone else's bikes (read-only)
router.get('/user/:uid', async (req, res) => {
  try {
    const bikes = await Bike.find({ userId: req.params.uid })
      .sort({ isPrimary: -1, createdAt: -1 })
      .lean();
    res.json({ items: bikes.map(dto) });
  } catch (e) {
    console.error('garage user list', e);
    res.status(500).json({ error: 'Failed to load garage' });
  }
});

// POST /api/garage — add a bike
router.post('/', async (req, res) => {
  try {
    const { make, model, year, displacement, nickname, photoUrl, isPrimary } = req.body || {};
    if (!make || !model) {
      return res.status(400).json({ error: 'make and model are required' });
    }

    const existingCount = await Bike.countDocuments({ userId: req.user.uid });
    const shouldBePrimary = existingCount === 0 ? true : !!isPrimary;

    if (shouldBePrimary) {
      await Bike.updateMany(
        { userId: req.user.uid, isPrimary: true },
        { $set: { isPrimary: false } }
      );
    }

    const bike = await Bike.create({
      userId: req.user.uid,
      make: String(make).trim(),
      model: String(model).trim(),
      year: year ? Number(year) : null,
      displacement: displacement ? Number(displacement) : null,
      nickname: nickname ? String(nickname).trim() : '',
      photoUrl: photoUrl || '',
      isPrimary: shouldBePrimary
    });

    res.status(201).json(dto(bike));
  } catch (e) {
    console.error('garage create', e);
    res.status(500).json({ error: 'Failed to add bike' });
  }
});

// PATCH /api/garage/:id — update fields
router.patch('/:id', async (req, res) => {
  try {
    const bike = await Bike.findOne({ _id: req.params.id, userId: req.user.uid });
    if (!bike) return res.status(404).json({ error: 'Bike not found' });

    const { make, model, year, displacement, nickname, photoUrl, isPrimary } = req.body || {};
    if (make !== undefined) bike.make = String(make).trim();
    if (model !== undefined) bike.model = String(model).trim();
    if (year !== undefined) bike.year = year ? Number(year) : null;
    if (displacement !== undefined) bike.displacement = displacement ? Number(displacement) : null;
    if (nickname !== undefined) bike.nickname = String(nickname).trim();
    if (photoUrl !== undefined) bike.photoUrl = photoUrl;

    if (isPrimary === true && !bike.isPrimary) {
      await Bike.updateMany(
        { userId: req.user.uid, isPrimary: true, _id: { $ne: bike._id } },
        { $set: { isPrimary: false } }
      );
      bike.isPrimary = true;
    } else if (isPrimary === false && bike.isPrimary) {
      bike.isPrimary = false;
    }

    await bike.save();
    res.json(dto(bike));
  } catch (e) {
    console.error('garage update', e);
    res.status(500).json({ error: 'Failed to update bike' });
  }
});

// POST /api/garage/:id/primary — promote to primary
router.post('/:id/primary', async (req, res) => {
  try {
    const bike = await Bike.findOne({ _id: req.params.id, userId: req.user.uid });
    if (!bike) return res.status(404).json({ error: 'Bike not found' });

    await Bike.updateMany(
      { userId: req.user.uid, isPrimary: true, _id: { $ne: bike._id } },
      { $set: { isPrimary: false } }
    );
    bike.isPrimary = true;
    await bike.save();
    res.json(dto(bike));
  } catch (e) {
    console.error('garage primary', e);
    res.status(500).json({ error: 'Failed to set primary' });
  }
});

// DELETE /api/garage/:id
router.delete('/:id', async (req, res) => {
  try {
    const bike = await Bike.findOneAndDelete({ _id: req.params.id, userId: req.user.uid });
    if (!bike) return res.status(404).json({ error: 'Bike not found' });

    // If we removed the primary, promote the most recent remaining bike (if any).
    if (bike.isPrimary) {
      const next = await Bike.findOne({ userId: req.user.uid }).sort({ createdAt: -1 });
      if (next) {
        next.isPrimary = true;
        await next.save();
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('garage delete', e);
    res.status(500).json({ error: 'Failed to delete bike' });
  }
});

module.exports = router;
