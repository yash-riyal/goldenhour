// server/services/matching.js
// Smart hospital matching + atomic bed reservation.
// Called when an AI assessment lands and we need to route the patient.

const db = require('../db/database');

function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fallback chain — if AI asks for trauma but no nearby hospital has trauma
// beds free, what's the next best bed type?
// 🤔 ASSUMPTION: trauma → icu → operation → emergency → general (progressively less specialized).
const BED_FALLBACK = {
  trauma:    ['trauma','icu','operation','emergency','general'],
  burn:      ['burn','icu','operation','emergency','general'],
  cardiac:   ['cardiac','icu','emergency','general'],
  icu:       ['icu','trauma','operation','emergency','general'],
  operation: ['operation','trauma','icu','emergency','general'],
  pediatric: ['pediatric','general','emergency'],
  maternity: ['maternity','general','emergency'],
  emergency: ['emergency','general'],
  general:   ['general','emergency']
};

/**
 * Find the best hospital + reserve a bed atomically.
 *
 * Inputs:
 *   - lat, lng        : where the patient is (accident scene)
 *   - requiredBedType : what AI said the patient needs
 *   - requiredCapabilities : array of capability tags the hospital must have
 *   - emergencyId     : id of the emergency we're matching
 *
 * Returns:
 *   { hospital, bed, bedType, distance_km, eta_minutes }  on success
 *   { error: 'no_match' }                                  if nothing matches
 *
 * Reservation is done inside a transaction so two concurrent emergencies
 * can never grab the same bed.
 */
function matchAndReserve({ lat, lng, requiredBedType, requiredCapabilities, emergencyId }) {
  const fallbackChain = BED_FALLBACK[requiredBedType] || [requiredBedType, 'general'];

  return db.transaction(() => {
    // 1. Pre-fetch all hospitals with their distance.
    const hospitals = db.prepare(`
      SELECT id, name, org_name, address, lat, lng, phone
      FROM users
      WHERE role='hospital' AND lat IS NOT NULL AND lng IS NOT NULL
    `).all();

    if (!hospitals.length) return { error: 'no_hospitals' };

    const withDistance = hospitals
      .map((h) => ({ ...h, distance_km: haversine(lat, lng, h.lat, h.lng) }))
      .sort((a, b) => a.distance_km - b.distance_km);

    // 2. Pre-fetch all required capabilities for each hospital we'll consider.
    const capRows = db.prepare(
      'SELECT hospital_id, capability FROM hospital_capabilities'
    ).all();
    const capsByHospital = new Map();
    for (const r of capRows) {
      if (!capsByHospital.has(r.hospital_id)) capsByHospital.set(r.hospital_id, new Set());
      capsByHospital.get(r.hospital_id).add(r.capability);
    }

    const hasAllCaps = (hospitalId) => {
      if (!requiredCapabilities || !requiredCapabilities.length) return true;
      const set = capsByHospital.get(hospitalId);
      if (!set) return false;
      // 🤔 ASSUMPTION: a hospital must have *all* required capabilities to qualify.
      //                Could relax to "most" later if matching is too strict.
      return requiredCapabilities.every((c) => set.has(c));
    };

    // 3. Walk hospitals nearest-first; for each, try the bed-type fallback chain.
    for (const h of withDistance) {
      if (!hasAllCaps(h.id)) continue;

      for (const bedType of fallbackChain) {
        // Atomically claim a free bed of this type at this hospital.
        const free = db.prepare(`
          SELECT id, bed_label FROM hospital_beds
          WHERE hospital_id = ? AND bed_type = ? AND status = 'available'
          LIMIT 1
        `).get(h.id, bedType);

        if (!free) continue;

        // Reserve it.
        db.prepare(`
          UPDATE hospital_beds
          SET status = 'reserved',
              current_emergency_id = ?,
              reserved_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'available'
        `).run(emergencyId, free.id);

        // ETA: simple urban estimate at 35 km/h. Phase 3 swaps in OSRM if you want real roads.
        const etaMinutes = Math.max(2, Math.round((h.distance_km / 35) * 60));

        return {
          hospital: {
            id: h.id, name: h.name, org_name: h.org_name,
            address: h.address, lat: h.lat, lng: h.lng, phone: h.phone
          },
          bed: { id: free.id, label: free.bed_label, type: bedType },
          bedType,
          fallbackUsed: bedType !== requiredBedType,
          distance_km: h.distance_km,
          eta_minutes: etaMinutes
        };
      }
    }

    return { error: 'no_match' };
  })();
}

/** Release a previously reserved bed (e.g. patient never arrived, case cancelled). */
function releaseBed(bedId) {
  db.prepare(`
    UPDATE hospital_beds
    SET status = 'available',
        current_emergency_id = NULL,
        reserved_at = NULL,
        occupied_at = NULL
    WHERE id = ?
  `).run(bedId);
}

/** Mark a reserved bed as occupied once the patient physically arrives. */
function occupyBed(bedId) {
  db.prepare(`
    UPDATE hospital_beds
    SET status = 'occupied', occupied_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'reserved'
  `).run(bedId);
}

/** Inventory snapshot for one hospital. */
function getBedInventory(hospitalId) {
  return db.prepare(`
    SELECT bed_type,
           SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) AS available,
           SUM(CASE WHEN status='reserved'  THEN 1 ELSE 0 END) AS reserved,
           SUM(CASE WHEN status='occupied'  THEN 1 ELSE 0 END) AS occupied,
           COUNT(*) AS total
    FROM hospital_beds
    WHERE hospital_id = ?
    GROUP BY bed_type
    ORDER BY bed_type
  `).all(hospitalId);
}

/** Every individual bed for one hospital, with the linked emergency (if any). */
function getIndividualBeds(hospitalId) {
  return db.prepare(`
    SELECT b.id, b.bed_type, b.bed_label, b.status, b.current_emergency_id,
           e.request_code, e.ai_severity, e.status AS emergency_status
    FROM hospital_beds b
    LEFT JOIN emergencies e ON e.id = b.current_emergency_id
    WHERE b.hospital_id = ?
    ORDER BY FIELD(b.bed_type,'icu','trauma','emergency','operation','cardiac','burn','general','pediatric','maternity'), b.id
  `).all(hospitalId);
}

/**
 * Hospital manually sets a bed's status. The hospital has full control over
 * ALL its beds — available, occupied, or even a reserved one (e.g. to mark the
 * patient as arrived, or to release a cancelled reservation).
 * The 'reserved' state is still set AUTOMATICALLY when an ambulance is incoming
 * (so a second ambulance can't grab the same bed), but the hospital can override it.
 * Returns { ok } or { error }.
 */
function toggleBedStatus(bedId, hospitalId, newStatus) {
  if (!['available', 'occupied'].includes(newStatus)) return { error: 'invalid_status' };
  return db.transaction(() => {
    const bed = db.prepare('SELECT * FROM hospital_beds WHERE id = ? AND hospital_id = ?').get(bedId, hospitalId);
    if (!bed) return { error: 'not_found' };
    db.prepare(`
      UPDATE hospital_beds
      SET status = ?,
          current_emergency_id = NULL,
          reserved_at = NULL,
          occupied_at = CASE WHEN ? = 'occupied' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id = ? AND hospital_id = ?
    `).run(newStatus, newStatus, bedId, hospitalId);
    return { ok: true };
  })();
}

module.exports = { matchAndReserve, releaseBed, occupyBed, getBedInventory, getIndividualBeds, toggleBedStatus, haversine };
