// server/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { sign, authRequired } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/signup
router.post('/signup', (req, res) => {
  try {
    const {
      role, name, email, phone, password,
      vehicle_number, license_number,
      org_name, address
    } = req.body;

    if (!role || !name || !email || !password) {
      return res.status(400).json({ error: 'role, name, email, password are required' });
    }
    if (!['driver', 'hospital', 'bloodbank'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = bcrypt.hashSync(password, 10);

    const result = db.prepare(`
      INSERT INTO users (role, name, email, phone, password_hash,
                         vehicle_number, license_number, org_name, address, is_available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(role, name, email, phone || null, password_hash,
           vehicle_number || null, license_number || null,
           org_name || null, address || null);

    // 🆕 Auto-seed bed inventory + capabilities for newly-signed-up hospitals.
    // 🤔 ASSUMPTION: new hospitals get the "multispecialty" tier (7 bed types, 30 beds).
    if (role === 'hospital') {
      const newHospitalId = result.lastInsertRowid;
      const tier = {
        beds: {
          general: 12, icu: 4, emergency: 5, operation: 3,
          trauma: 2, cardiac: 2, pediatric: 2
        },
        capabilities: [
          'general_surgery','orthopedics','cardiology','pediatrics',
          'intensive_care','emergency_care','trauma_care'
        ]
      };
      const insertCap = db.prepare(
        'INSERT OR IGNORE INTO hospital_capabilities (hospital_id, capability) VALUES (?, ?)'
      );
      const insertBed = db.prepare(
        'INSERT INTO hospital_beds (hospital_id, bed_type, bed_label, status) VALUES (?, ?, ?, ?)'
      );
      for (const cap of tier.capabilities) insertCap.run(newHospitalId, cap);
      for (const [bedType, count] of Object.entries(tier.beds)) {
        for (let i = 1; i <= count; i++) {
          const label = `${bedType.toUpperCase()}-${i.toString().padStart(2, '0')}`;
          // 30% pre-occupied for realism
          const preOccupy = Math.random() < 0.3;
          insertBed.run(newHospitalId, bedType, label, preOccupy ? 'occupied' : 'available');
        }
      }
    }

    const user = db.prepare(`
      SELECT id, role, name, email, phone, vehicle_number, license_number,
             org_name, address, lat, lng, is_available
      FROM users WHERE id = ?
    `).get(result.lastInsertRowid);
    const token = sign({ id: user.id, role: user.role, email: user.email, name: user.name });
    res.json({ token, user });
  } catch (err) {
    console.error('[signup]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = sign({ id: user.id, role: user.role, email: user.email, name: user.name });
    const publicUser = {
      id: user.id, role: user.role, name: user.name, email: user.email,
      phone: user.phone, org_name: user.org_name, vehicle_number: user.vehicle_number
    };
    res.json({ token, user: publicUser });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', authRequired, (req, res) => {
  const user = db.prepare(`
    SELECT id, role, name, email, phone, vehicle_number, license_number,
           org_name, address, lat, lng, is_available
    FROM users WHERE id = ?
  `).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

module.exports = router;
