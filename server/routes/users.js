// server/routes/users.js
const express = require('express');
const db = require('../db/database');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// POST /api/users/location  — update live GPS
router.post('/location', authRequired, (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat,lng numbers required' });
  }
  db.prepare(`
    UPDATE users SET lat = ?, lng = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?
  `).run(lat, lng, req.user.id);

  // Broadcast driver locations for live tracking
  const io = req.app.get('io');
  if (io && req.user.role === 'driver') {
    io.emit('driver:location', { driver_id: req.user.id, lat, lng });
  }
  res.json({ ok: true });
});

// GET /api/users/drivers  — list active drivers (for hospital map)
router.get('/drivers', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, vehicle_number, lat, lng, is_available, last_seen
    FROM users WHERE role='driver' AND lat IS NOT NULL
  `).all();
  res.json({ drivers: rows });
});

// POST /api/users/availability  — driver toggles availability
router.post('/availability', authRequired, (req, res) => {
  const { is_available } = req.body;
  db.prepare('UPDATE users SET is_available = ? WHERE id = ?')
    .run(is_available ? 1 : 0, req.user.id);
  res.json({ ok: true, is_available: !!is_available });
});

module.exports = router;
