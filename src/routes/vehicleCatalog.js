const express = require('express');
const router = express.Router();
const catalog = require('../services/bikeCatalog');

// GET /api/catalog/makes
router.get('/makes', async (req, res) => {
  try {
    const makes = await catalog.getMakes();
    res.json({ items: makes });
  } catch (e) {
    console.error('catalog makes', e);
    res.status(502).json({ error: 'Catalog upstream error' });
  }
});

// GET /api/catalog/models?make=...&year=...
router.get('/models', async (req, res) => {
  try {
    const make = String(req.query.make || '').trim();
    const year = req.query.year ? Number(req.query.year) : null;
    if (!make) return res.status(400).json({ error: 'make required' });
    if (year && (year < 1900 || year > 2100)) {
      return res.status(400).json({ error: 'year out of range' });
    }
    const models = await catalog.getModels(make, year);
    res.json({ items: models });
  } catch (e) {
    console.error('catalog models', e);
    res.status(502).json({ error: 'Catalog upstream error' });
  }
});

module.exports = router;
