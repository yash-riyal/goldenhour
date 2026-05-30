// server/services/dispatch.js
// Handles the SOS broadcast to drivers and the 15-second timeout fallback.
//
// 🤔 ASSUMPTIONS (all per user spec, locked in):
//   - Top 5 nearest available drivers see the alert simultaneously.
//   - 15 seconds to accept or reject. First to accept wins.
//   - If no one accepts in 15s → auto-assign to the SINGLE nearest available driver.

const db = require('../db/database');
const { haversine } = require('./matching');

const SOS_WINDOW_MS = 15 * 1000;
const SOS_BROADCAST_LIMIT = 5;

// Active timers, keyed by emergency_id, so we can cancel on acceptance.
const pendingTimeouts = new Map();

function getAvailableDrivers() {
  // A driver is "available" for a NEW sos only if:
  //   - role driver, marked is_available, has a known location, AND
  //   - is NOT already busy on an active case (accepted/reached/picked).
  // This is what makes a second simultaneous emergency skip a busy driver
  // (e.g. Yash is on a trip → Samruddhi gets the next SOS).
  return db.prepare(`
    SELECT u.id, u.name, u.phone, u.vehicle_number, u.lat, u.lng
    FROM users u
    WHERE u.role='driver' AND u.is_available=1
      AND u.lat IS NOT NULL AND u.lng IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM emergencies e
        WHERE e.assigned_driver_id = u.id
          AND e.status IN ('accepted','reached','picked')
      )
  `).all();
}

function topNearestDrivers(lat, lng, limit) {
  return getAvailableDrivers()
    .map((d) => ({ ...d, distance_km: haversine(lat, lng, d.lat, d.lng) }))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);
}

/**
 * Broadcast an emergency to the top N nearest drivers.
 * Records an `emergency_offers` row per driver so we can audit who saw what.
 * Schedules a 15s timeout for auto-assignment if no one accepts.
 */
function broadcastSos({ emergencyId, lat, lng, io }) {
  const nearby = topNearestDrivers(lat, lng, SOS_BROADCAST_LIMIT);
  if (!nearby.length) {
    console.warn(`[dispatch] No available drivers near (${lat},${lng})`);
    return { offered: [], reason: 'no_drivers' };
  }

  const insertOffer = db.prepare(`
    INSERT OR IGNORE INTO emergency_offers (emergency_id, driver_id, status)
    VALUES (?, ?, 'pending')
  `);

  const emergency = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(emergencyId);

  for (const d of nearby) {
    insertOffer.run(emergencyId, d.id);

    if (io) {
      io.to(`driver:${d.id}`).emit('sos:new', {
        emergency,
        distance_km: d.distance_km,
        eta_minutes: Math.max(1, Math.round((d.distance_km / 35) * 60)),
        expires_at: Date.now() + SOS_WINDOW_MS,
        window_ms: SOS_WINDOW_MS
      });
    }
  }

  // Schedule the auto-assign fallback.
  scheduleAutoAssign(emergencyId, lat, lng, io);

  return { offered: nearby, window_ms: SOS_WINDOW_MS };
}

function scheduleAutoAssign(emergencyId, lat, lng, io) {
  // Cancel any prior timer (e.g. if this is a re-broadcast).
  cancelAutoAssign(emergencyId);

  const handle = setTimeout(() => {
    pendingTimeouts.delete(emergencyId);
    try { runAutoAssign(emergencyId, lat, lng, io); }
    catch (err) { console.error('[dispatch] auto-assign error:', err); }
  }, SOS_WINDOW_MS);

  pendingTimeouts.set(emergencyId, handle);
}

function cancelAutoAssign(emergencyId) {
  const h = pendingTimeouts.get(emergencyId);
  if (h) {
    clearTimeout(h);
    pendingTimeouts.delete(emergencyId);
  }
}

/**
 * Called either by the 15-second timer OR manually if you want to force-assign.
 * Looks at the current state — only auto-assigns if still no driver claimed it.
 */
function runAutoAssign(emergencyId, lat, lng, io) {
  const em = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(emergencyId);
  if (!em || em.assigned_driver_id || em.status !== 'requested') return; // Someone got it.

  // Expire all pending offers for this case.
  db.prepare(`
    UPDATE emergency_offers SET status='expired', responded_at=CURRENT_TIMESTAMP
    WHERE emergency_id = ? AND status='pending'
  `).run(emergencyId);

  // Pick the single nearest available driver, Uber-style.
  const nearest = topNearestDrivers(lat, lng, 1)[0];
  if (!nearest) {
    console.warn(`[dispatch] auto-assign: no available drivers for emergency ${emergencyId}`);
    return;
  }

  db.prepare(`
    UPDATE emergencies
    SET assigned_driver_id = ?, status='accepted',
        accepted_at=CURRENT_TIMESTAMP, auto_assigned_at=CURRENT_TIMESTAMP
    WHERE id = ? AND assigned_driver_id IS NULL
  `).run(nearest.id, emergencyId);

  db.prepare(`
    INSERT OR REPLACE INTO emergency_offers (emergency_id, driver_id, status, responded_at)
    VALUES (?, ?, 'accepted', CURRENT_TIMESTAMP)
  `).run(emergencyId, nearest.id);

  db.prepare(`
    INSERT INTO emergency_events (emergency_id, event_type, actor_role, actor_id, payload)
    VALUES (?, 'auto_assigned', 'system', NULL, ?)
  `).run(emergencyId, JSON.stringify({ driver_id: nearest.id, distance_km: nearest.distance_km }));

  const updated = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(emergencyId);

  if (io) {
    // Tell the chosen driver they've been auto-assigned.
    io.to(`driver:${nearest.id}`).emit('sos:auto_assigned', {
      emergency: updated,
      distance_km: nearest.distance_km
    });
    // Tell everyone else the case is gone.
    io.emit('emergency:update', { emergency: updated });
  }

  console.log(`[dispatch] auto-assigned emergency ${emergencyId} -> driver ${nearest.id}`);
}

module.exports = {
  broadcastSos,
  cancelAutoAssign,
  topNearestDrivers,
  SOS_WINDOW_MS,
};
