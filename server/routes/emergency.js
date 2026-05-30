// server/routes/emergency.js
// Routes for the full SOS / dispatch / AI / matching flow.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('../db/database');
const { authRequired, requireRole } = require('../middleware/auth');
const { analyzeInjury } = require('../services/ai');
const { matchAndReserve, releaseBed, occupyBed, getBedInventory, getIndividualBeds, toggleBedStatus, haversine } = require('../services/matching');
const { broadcastSos, cancelAutoAssign, topNearestDrivers } = require('../services/dispatch');

const router = express.Router();

// ─── Multer setup for media uploads ─────────────────────────────
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'server/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname || ''));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /^(image|video)\//.test(file.mimetype);
    cb(ok ? null : new Error('Only image or video files allowed'), ok);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────
function generateCode() {
  return 'EM' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}
function logEvent(emergencyId, eventType, actorRole = null, actorId = null, payload = null) {
  db.prepare(`
    INSERT INTO emergency_events (emergency_id, event_type, actor_role, actor_id, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(emergencyId, eventType, actorRole, actorId, payload ? JSON.stringify(payload) : null);
}

// Realistic random Pune-area coords for the "Simulate 112 Call" button.
// 🤔 ASSUMPTION: cluster around central Pune so seeded drivers/hospitals are nearby.
function randomPuneCoords() {
  // Covers all of Pune: central, Kothrud, Katraj, Hadapsar, Yerawada, Pimpri.
  const zones = [
    { lat: 18.5204, lng: 73.8567, r: 4 },  // Central Pune
    { lat: 18.4583, lng: 73.8531, r: 3 },  // Katraj / South Pune
    { lat: 18.4889, lng: 73.9259, r: 3 },  // Hadapsar / East Pune
    { lat: 18.5170, lng: 73.8313, r: 3 },  // Erandwane / Kothrud
    { lat: 18.5450, lng: 73.8700, r: 3 },  // Yerawada / North Pune
  ];
  // Pick a random zone
  const z = zones[Math.floor(Math.random() * zones.length)];
  const dLat = (Math.random() - 0.5) * (z.r / 111) * 2;
  const dLng = (Math.random() - 0.5) * (z.r / (111 * Math.cos(z.lat * Math.PI / 180))) * 2;
  return { lat: +(z.lat + dLat).toFixed(6), lng: +(z.lng + dLng).toFixed(6) };
}

// ─── DISPATCH (112 simulator) ────────────────────────────────────
/**
 * POST /api/emergency/sos
 * Public (simulating a 112 call landing in the system).
 * Body: { lat?, lng?, caller_phone? }   — if omitted, uses random Pune coords.
 * Creates emergency, broadcasts to top 5 nearest drivers, starts 15s auto-assign timer.
 */
router.post('/sos', (req, res) => {
  try {
    let lat = parseFloat(req.body.lat);
    let lng = parseFloat(req.body.lng);
    if (isNaN(lat) || isNaN(lng)) {
      const r = randomPuneCoords();
      lat = r.lat; lng = r.lng;
    }
    const callerPhone = req.body.caller_phone || `+91-${Math.floor(7000000000 + Math.random() * 2999999999)}`;
    const code = generateCode();

    const result = db.prepare(`
      INSERT INTO emergencies (request_code, reporter_lat, reporter_lng,
                               caller_phone, source, status)
      VALUES (?, ?, ?, ?, '112', 'requested')
    `).run(code, lat, lng, callerPhone);

    const emergencyId = result.lastInsertRowid;
    logEvent(emergencyId, 'sos_received', 'system', null, { lat, lng, callerPhone });

    const io = req.app.get('io');
    const { offered, reason, window_ms } = broadcastSos({ emergencyId, lat, lng, io });

    const emergency = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(emergencyId);

    res.json({
      success: true,
      emergency,
      drivers_notified: offered.length,
      window_ms,
      no_drivers: reason === 'no_drivers'
    });
  } catch (err) {
    console.error('[emergency/sos]', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─── DRIVER: ACCEPT / REJECT ─────────────────────────────────────
/**
 * POST /api/emergency/:id/accept   (driver only)
 * First driver to call this wins the case. Cancels the auto-assign timer.
 */
router.post('/:id/accept', authRequired, requireRole('driver'), (req, res) => {
  const id = req.params.id;
  try {
    const result = db.transaction(() => {
      const e = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
      if (!e) return { error: 'not_found', status: 404 };
      if (e.assigned_driver_id) {
        return { error: 'already_taken', status: 409 };
      }
      db.prepare(`
        UPDATE emergencies SET assigned_driver_id = ?, status='accepted', accepted_at=CURRENT_TIMESTAMP
        WHERE id = ? AND assigned_driver_id IS NULL
      `).run(req.user.id, id);

      // Expire other offers
      db.prepare(`
        UPDATE emergency_offers SET status='expired', responded_at=CURRENT_TIMESTAMP
        WHERE emergency_id = ? AND status='pending' AND driver_id != ?
      `).run(id, req.user.id);

      db.prepare(`
        INSERT OR REPLACE INTO emergency_offers (emergency_id, driver_id, status, responded_at)
        VALUES (?, ?, 'accepted', CURRENT_TIMESTAMP)
      `).run(id, req.user.id);

      return { ok: true };
    })();

    if (result.error) return res.status(result.status).json({ error: result.error });

    cancelAutoAssign(parseInt(id));
    logEvent(id, 'accepted', 'driver', req.user.id);

    const updated = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
    const io = req.app.get('io');
    if (io) io.emit('emergency:update', { emergency: updated });

    res.json({ emergency: updated });
  } catch (err) {
    console.error('[accept]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/emergency/:id/reject   (driver only)
 * Driver declined; offer marked rejected. Doesn't cancel the auto-assign timer
 * (others may still accept; if all 5 reject or none respond, auto-assign fires).
 */
router.post('/:id/reject', authRequired, requireRole('driver'), (req, res) => {
  const id = req.params.id;
  db.prepare(`
    UPDATE emergency_offers SET status='rejected', responded_at=CURRENT_TIMESTAMP
    WHERE emergency_id = ? AND driver_id = ?
  `).run(id, req.user.id);
  logEvent(id, 'rejected', 'driver', req.user.id);
  res.json({ ok: true });
});

// ─── DRIVER: STATUS WORKFLOW ─────────────────────────────────────
/**
 * POST /api/emergency/:id/status   (driver only)
 * Body: { status: 'reached'|'picked'|'hospital_reached' }
 * When 'hospital_reached', also marks the reserved bed as occupied.
 */
router.post('/:id/status', authRequired, requireRole('driver'), (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  const valid = ['reached', 'picked', 'hospital_reached'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const e = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.assigned_driver_id !== req.user.id) return res.status(403).json({ error: 'Not your emergency' });

  const tsCol = { reached: 'reached_at', picked: 'picked_at', hospital_reached: 'hospital_reached_at' }[status];
  db.prepare(`UPDATE emergencies SET status = ?, ${tsCol} = CURRENT_TIMESTAMP WHERE id = ?`).run(status, id);
  logEvent(id, 'status_change', 'driver', req.user.id, { status });

  // Patient now physically in the hospital bed.
  if (status === 'hospital_reached' && e.reserved_bed_id) {
    occupyBed(e.reserved_bed_id);
  }

  const updated = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
  const io = req.app.get('io');
  if (io) {
    io.emit('emergency:update', { emergency: updated });
    if (e.assigned_hospital_id) {
      io.to(`hospital:${e.assigned_hospital_id}`).emit('beds:update', { beds: getIndividualBeds(e.assigned_hospital_id) });
    }
  }
  res.json({ emergency: updated });
});

// ─── DRIVER: UPLOAD PHOTO AT SCENE → AI → BED RESERVATION ────────
/**
 * POST /api/emergency/:id/photo  (driver only, multipart)
 * Form-data: media (image/video)
 *
 * Flow:
 *   1. Save media
 *   2. Run AI analysis
 *   3. Update emergency with AI results
 *   4. Reserve a hospital bed atomically
 *   5. If blood needed → create blood_alert, broadcast to blood banks
 *   6. Notify hospital + blood banks via socket
 */
router.post('/:id/photo', authRequired, requireRole('driver'), upload.single('media'), async (req, res) => {
  try {
    const id = req.params.id;
    const e = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
    if (!e) return res.status(404).json({ error: 'Not found' });
    if (e.assigned_driver_id !== req.user.id) return res.status(403).json({ error: 'Not your emergency' });
    if (!req.file) return res.status(400).json({ error: 'Photo required' });

    const mediaPath = '/uploads/' + req.file.filename;
    const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';

    db.prepare('UPDATE emergencies SET media_path = ?, media_type = ? WHERE id = ?')
      .run(mediaPath, mediaType, id);

    // 1. AI analysis
    const filePath = path.join(uploadDir, req.file.filename);
    const ai = await analyzeInjury({ filePath, mediaType });

    db.prepare(`
      UPDATE emergencies SET
        ai_severity = ?, ai_injury_type = ?, ai_required_bed_type = ?,
        ai_required_capabilities = ?, ai_blood_group = ?, ai_blood_units = ?,
        ai_summary = ?, ai_confidence = ?, ai_completed_at = CURRENT_TIMESTAMP,
        severity = CASE WHEN ? IN ('severe','critical') THEN 'critical' ELSE 'normal' END,
        blood_required = ?, blood_units_required = ?
      WHERE id = ?
    `).run(
      ai.severity, ai.injury_type, ai.required_bed_type,
      JSON.stringify(ai.required_capabilities || []), ai.blood_group, ai.blood_units,
      ai.summary, ai.confidence,
      ai.severity,                 // for severity column
      ai.blood_group, ai.blood_units,
      id
    );
    logEvent(id, 'ai_assessed', 'system', null, ai);

    // 2. Hospital + bed matching
    const match = matchAndReserve({
      lat: e.reporter_lat,
      lng: e.reporter_lng,
      requiredBedType: ai.required_bed_type,
      requiredCapabilities: ai.required_capabilities,
      emergencyId: parseInt(id)
    });

    if (match.error) {
      // No suitable hospital found. We still keep the AI result and let UI surface it.
      logEvent(id, 'matching_failed', 'system', null, match);
      const updated = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
      const io = req.app.get('io');
      if (io) io.emit('emergency:update', { emergency: updated, ai });
      return res.json({ emergency: updated, ai, match });
    }

    db.prepare(`
      UPDATE emergencies SET assigned_hospital_id = ?, reserved_bed_id = ?
      WHERE id = ?
    `).run(match.hospital.id, match.bed.id, id);

    logEvent(id, 'hospital_assigned', 'system', null, {
      hospital_id: match.hospital.id, bed: match.bed, distance_km: match.distance_km
    });

    // 3. Blood alert — ALWAYS notify blood banks when a hospital is assigned.
    // Even if AI doesn't flag blood as needed, blood banks should be on standby
    // with full case context (photo, AI summary, hospital details).
    // blood_group = null and units_required = 0 means "standby, no specific request yet".
    const r = db.prepare(`
      INSERT INTO blood_alerts (emergency_id, hospital_id, blood_group, units_required, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(id, match.hospital.id, ai.blood_group || null, ai.blood_units || 0);

    const bloodAlert = db.prepare(`
      SELECT b.*, h.org_name AS hospital_name, h.address AS hospital_address,
             h.lat AS hospital_lat, h.lng AS hospital_lng,
             e.request_code, e.severity, e.media_path, e.media_type, e.ai_summary, e.ai_injury_type
      FROM blood_alerts b
      JOIN users h ON h.id = b.hospital_id
      JOIN emergencies e ON e.id = b.emergency_id
      WHERE b.id = ?
    `).get(r.lastInsertRowid);

    logEvent(id, 'blood_alert', 'system', null, {
      blood_group: ai.blood_group,
      units: ai.blood_units,
      blood_needed: ai.blood_needed
    });

    const updated = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
    const io = req.app.get('io');
    if (io) {
      io.emit('emergency:update', { emergency: updated, ai, match });
      io.to(`hospital:${match.hospital.id}`).emit('emergency:incoming', { emergency: updated, ai, match });
      io.to(`hospital:${match.hospital.id}`).emit('beds:update', { beds: getIndividualBeds(match.hospital.id) });
      if (bloodAlert) io.to('bloodbanks').emit('blood:alert', bloodAlert);
    }

    res.json({ emergency: updated, ai, match, blood_alert: bloodAlert });
  } catch (err) {
    console.error('[photo]', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─── LIST / GET ──────────────────────────────────────────────────
router.get('/list', authRequired, (req, res) => {
  const { role, id } = req.user;
  let rows;
  if (role === 'driver') {
    // Driver sees: pending SOS offers to them + their active/recent cases.
    rows = db.prepare(`
      SELECT e.*,
             h.org_name AS hospital_name, h.address AS hospital_address,
             h.lat AS hospital_lat, h.lng AS hospital_lng,
             b.bed_label AS reserved_bed_label, b.bed_type AS reserved_bed_type
      FROM emergencies e
      LEFT JOIN users h ON h.id = e.assigned_hospital_id
      LEFT JOIN hospital_beds b ON b.id = e.reserved_bed_id
      WHERE e.assigned_driver_id = ?
         OR e.id IN (SELECT emergency_id FROM emergency_offers WHERE driver_id = ? AND status='pending')
      ORDER BY e.created_at DESC LIMIT 50
    `).all(id, id);
  } else if (role === 'hospital') {
    rows = db.prepare(`
      SELECT e.*,
             d.name AS driver_name, d.vehicle_number, d.phone AS driver_phone,
             d.lat AS driver_lat, d.lng AS driver_lng,
             b.bed_label AS reserved_bed_label, b.bed_type AS reserved_bed_type
      FROM emergencies e
      LEFT JOIN users d ON d.id = e.assigned_driver_id
      LEFT JOIN hospital_beds b ON b.id = e.reserved_bed_id
      WHERE e.assigned_hospital_id = ?
      ORDER BY e.created_at DESC LIMIT 50
    `).all(id);
  } else {
    // Blood banks see emergencies tied to blood alerts they can act on.
    rows = db.prepare(`
      SELECT DISTINCT e.*, h.org_name AS hospital_name
      FROM emergencies e
      JOIN blood_alerts b ON b.emergency_id = e.id
      LEFT JOIN users h ON h.id = e.assigned_hospital_id
      WHERE b.bloodbank_id = ? OR b.bloodbank_id IS NULL
      ORDER BY e.created_at DESC LIMIT 50
    `).all(id);
  }
  res.json({ emergencies: rows });
});

// ─── BED INVENTORY (hospital only) — registered before /:id ─────────
router.get('/beds/inventory', authRequired, requireRole('hospital'), (req, res) => {
  res.json({ inventory: getBedInventory(req.user.id) });
});

// Individual beds (each bed cell) for the interactive grid.
router.get('/beds/list', authRequired, requireRole('hospital'), (req, res) => {
  res.json({ beds: getIndividualBeds(req.user.id) });
});

// Hospital manually flips a bed available <-> occupied.
router.post('/beds/:bedId/toggle', authRequired, requireRole('hospital'), (req, res) => {
  const { status } = req.body;
  const result = toggleBedStatus(parseInt(req.params.bedId), req.user.id, status);
  if (result.error) {
    const code = result.error === 'bed_reserved' ? 409 : 400;
    return res.status(code).json({ error: result.error });
  }
  const io = req.app.get('io');
  if (io) io.to(`hospital:${req.user.id}`).emit('beds:update', { beds: getIndividualBeds(req.user.id) });
  res.json({ ok: true, beds: getIndividualBeds(req.user.id) });
});

router.get('/:id', authRequired, (req, res) => {
  const e = db.prepare(`
    SELECT e.*,
           d.name AS driver_name, d.vehicle_number, d.phone AS driver_phone,
           d.lat AS driver_lat, d.lng AS driver_lng,
           h.org_name AS hospital_name, h.address AS hospital_address,
           h.lat AS hospital_lat, h.lng AS hospital_lng,
           b.bed_label AS reserved_bed_label, b.bed_type AS reserved_bed_type
    FROM emergencies e
    LEFT JOIN users d ON d.id = e.assigned_driver_id
    LEFT JOIN users h ON h.id = e.assigned_hospital_id
    LEFT JOIN hospital_beds b ON b.id = e.reserved_bed_id
    WHERE e.id = ?
  `).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  res.json({ emergency: e });
});

// ─── BLOOD: hospital can also manually raise an alert ─────────────
/**
 * POST /api/emergency/:id/blood-alert  (hospital only)
 * Body: { blood_group, units_required, notes? }
 * Optional escape hatch if AI didn't flag blood need but hospital wants to.
 */
router.post('/:id/blood-alert', authRequired, requireRole('hospital'), (req, res) => {
  const id = req.params.id;
  const { blood_group, units_required, notes } = req.body;
  if (!blood_group) return res.status(400).json({ error: 'blood_group required' });

  const e = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'Not found' });

  db.prepare('UPDATE emergencies SET severity=?, blood_required=?, blood_units_required=?, notes=COALESCE(?, notes) WHERE id=?')
    .run('critical', blood_group, units_required || 1, notes || null, id);

  const r = db.prepare(`
    INSERT INTO blood_alerts (emergency_id, hospital_id, blood_group, units_required, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(id, req.user.id, blood_group, units_required || 1);

  const alert = db.prepare(`
    SELECT b.*, h.org_name AS hospital_name, h.address AS hospital_address,
           h.lat AS hospital_lat, h.lng AS hospital_lng,
           e.request_code, e.severity, e.media_path, e.media_type, e.ai_summary, e.ai_injury_type
    FROM blood_alerts b
    JOIN users h ON h.id = b.hospital_id
    JOIN emergencies e ON e.id = b.emergency_id
    WHERE b.id = ?
  `).get(r.lastInsertRowid);

  logEvent(id, 'blood_alert_manual', 'hospital', req.user.id, { blood_group, units_required });

  const io = req.app.get('io');
  if (io) io.to('bloodbanks').emit('blood:alert', alert);

  res.json({ alert });
});

// ─── BLOOD: bank-side ────────────────────────────────────────────
router.get('/blood/alerts', authRequired, requireRole('bloodbank'), (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, h.org_name AS hospital_name, h.address AS hospital_address,
           h.lat AS hospital_lat, h.lng AS hospital_lng,
           e.request_code, e.severity, e.media_path, e.media_type,
           e.ai_summary, e.ai_injury_type, e.ai_severity,
           e.reporter_lat, e.reporter_lng
    FROM blood_alerts b
    JOIN users h ON h.id = b.hospital_id
    JOIN emergencies e ON e.id = b.emergency_id
    WHERE b.bloodbank_id IS NULL OR b.bloodbank_id = ?
    ORDER BY b.created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ alerts: rows });
});

/**
 * POST /api/emergency/blood/alerts/:id/respond  (bloodbank only)
 * Body: { status: 'accepted'|'dispatched'|'fulfilled'|'rejected' }
 * On 'dispatched', server computes ETA from bloodbank -> hospital.
 */
router.post('/blood/alerts/:id/respond', authRequired, requireRole('bloodbank'), (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  const valid = ['accepted', 'dispatched', 'fulfilled', 'rejected'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const alert = db.prepare(`
    SELECT b.*, h.lat AS hospital_lat, h.lng AS hospital_lng
    FROM blood_alerts b JOIN users h ON h.id = b.hospital_id
    WHERE b.id = ?
  `).get(id);
  if (!alert) return res.status(404).json({ error: 'Not found' });

  // Compute ETA on dispatch (bank → hospital, ~30 km/h)
  let eta = null;
  if (status === 'dispatched') {
    const me = db.prepare('SELECT lat, lng FROM users WHERE id = ?').get(req.user.id);
    if (me && me.lat && me.lng) {
      const km = haversine(me.lat, me.lng, alert.hospital_lat, alert.hospital_lng);
      eta = Math.max(2, Math.round((km / 30) * 60));
    }
  }

  db.prepare(`
    UPDATE blood_alerts
    SET status = ?, bloodbank_id = ?, responded_at = CURRENT_TIMESTAMP,
        eta_minutes = COALESCE(?, eta_minutes),
        dispatched_at = CASE WHEN ? = 'dispatched' THEN CURRENT_TIMESTAMP ELSE dispatched_at END
    WHERE id = ?
  `).run(status, req.user.id, eta, status, id);

  const updated = db.prepare(`
    SELECT b.*, u.org_name AS bloodbank_name
    FROM blood_alerts b LEFT JOIN users u ON u.id = b.bloodbank_id
    WHERE b.id = ?
  `).get(id);

  const io = req.app.get('io');
  if (io) {
    io.to(`hospital:${updated.hospital_id}`).emit('blood:response', updated);
    io.to('bloodbanks').emit('blood:update', updated);
  }

  res.json({ alert: updated });
});

module.exports = router;
