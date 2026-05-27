// NHTSA vPIC motorcycle catalog (free, no API key).
// Docs: https://vpic.nhtsa.dot.gov/api/
//
// We cache responses for 24h in-memory to keep things snappy and stay polite.

const BASE = 'https://vpic.nhtsa.dot.gov/api';
const TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map(); // key -> { value, expiresAt }

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`vPIC ${res.status}`);
  return res.json();
}

// Returns: [{ name }] sorted alphabetically
async function getMakes() {
  const key = 'makes';
  const cached = getCached(key);
  if (cached) return cached;

  const url = `${BASE}/vehicles/GetMakesForVehicleType/motorcycle?format=json`;
  const data = await fetchJson(url);
  const results = (data.Results || [])
    .map(r => ({ name: String(r.MakeName || '').trim() }))
    .filter(r => r.name.length > 0);
  // De-dupe + sort
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const k = r.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  setCached(key, out);
  return out;
}

// Returns: [{ name }] sorted alphabetically
async function getModels(make, year) {
  if (!make) return [];
  const yearPart = year ? `/modelyear/${encodeURIComponent(year)}` : '';
  const key = `models:${make.toLowerCase()}:${year || 'any'}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = `${BASE}/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}${yearPart}/vehicleType/motorcycle?format=json`;
  const data = await fetchJson(url);
  const results = (data.Results || [])
    .map(r => ({ name: String(r.Model_Name || '').trim() }))
    .filter(r => r.name.length > 0);
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const k = r.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  setCached(key, out);
  return out;
}

module.exports = { getMakes, getModels };
