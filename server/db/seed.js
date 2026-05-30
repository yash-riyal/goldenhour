// server/db/seed.js
// Seeds demo users + hospital bed inventory + capabilities.
// Runs only when the users table is empty.

const bcrypt = require('bcryptjs');
const db = require('./database');

// Hospital tiers — EVERY hospital has ALL ward types and ALL capabilities.
// Only the bed COUNT differs by tier (bigger hospital = more beds).
// So any hospital can in principle handle any case — it just comes down to
// live availability (free vs occupied beds).
const ALL_CAPABILITIES = [
  'general_surgery','trauma_care','neurosurgery','orthopedics','cardiology',
  'burns','pediatrics','obstetrics','intensive_care','emergency_care'
];
const HOSPITAL_TIERS = {
  tertiary: {  // Big multi-specialty referral hospital — lots of beds
    beds: {
      general: 20, icu: 8, emergency: 10, operation: 5,
      trauma: 6, burn: 3, cardiac: 5, pediatric: 5, maternity: 4
    },
    capabilities: ALL_CAPABILITIES
  },
  multispecialty: {  // Mid-size hospital — moderate beds
    beds: {
      general: 14, icu: 5, emergency: 6, operation: 3,
      trauma: 3, burn: 2, cardiac: 3, pediatric: 3, maternity: 2
    },
    capabilities: ALL_CAPABILITIES
  },
  general: {  // Smaller hospital — fewer beds but still every ward
    beds: {
      general: 10, icu: 3, emergency: 4, operation: 2,
      trauma: 2, burn: 1, cardiac: 1, pediatric: 2, maternity: 1
    },
    capabilities: ALL_CAPABILITIES
  }
};

// Backfill: any hospital row that has zero beds gets the default "general" tier
// loadout so older DBs upgrade smoothly to the Phase 1 schema.
function backfillBedsAndCapabilities() {
  const hospitals = db.prepare(`SELECT id, org_name FROM users WHERE role='hospital'`).all();
  if (!hospitals.length) return;

  const insertCap = db.prepare(
    'INSERT IGNORE INTO hospital_capabilities (hospital_id, capability) VALUES (?, ?)'
  );
  const insertBed = db.prepare(
    'INSERT INTO hospital_beds (hospital_id, bed_type, bed_label, status) VALUES (?, ?, ?, ?)'
  );

  // 🤔 ASSUMPTION: backfilled hospitals get the "general" tier (core 4 only).
  //                Fresh installs get realistic mixed tiers via the main seed below.
  const tier = HOSPITAL_TIERS.general;

  let touched = 0;
  for (const h of hospitals) {
    const bedCount = db.prepare(
      'SELECT COUNT(*) AS c FROM hospital_beds WHERE hospital_id = ?'
    ).get(h.id).c;
    if (bedCount > 0) continue;

    for (const cap of tier.capabilities) insertCap.run(h.id, cap);
    for (const [bedType, count] of Object.entries(tier.beds)) {
      for (let i = 1; i <= count; i++) {
        const label = `${bedType.toUpperCase()}-${i.toString().padStart(2, '0')}`;
        const preOccupy = Math.random() < 0.3;
        insertBed.run(h.id, bedType, label, preOccupy ? 'occupied' : 'available');
      }
    }
    touched++;
  }
  if (touched) console.log(`[seed] backfilled beds + capabilities for ${touched} existing hospital(s)`);
}

function seed() {
  // Always backfill missing beds/capabilities so old DBs from before Phase 1
  // (which only have users but no bed inventory) get upgraded automatically.
  backfillBedsAndCapabilities();

  const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (existing.c > 0) {
    console.log(`[seed] ${existing.c} users already exist — skipping seed`);
    return;
  }

  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const insertUser = db.prepare(`
    INSERT INTO users (role, name, email, phone, password_hash,
                       vehicle_number, license_number, org_name, address,
                       lat, lng, is_available, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const insertCap = db.prepare(
    'INSERT INTO hospital_capabilities (hospital_id, capability) VALUES (?, ?)'
  );
  const insertBed = db.prepare(
    'INSERT INTO hospital_beds (hospital_id, bed_type, bed_label, status) VALUES (?, ?, ?, ?)'
  );

  // ─── Drivers — clustered around Pune (incl. Katraj/South Pune) ──
  const drivers = [
    { name: 'Yash Rawal',     email: 'driver@goldenhour.com',  phone: '+91-9876543210',
      vehicle: 'MH-12-AB-1234', license: 'DL-1420110012345', lat: 18.5204, lng: 73.8567 },
    { name: 'Samruddhi Joshi',email: 'driver2@goldenhour.com', phone: '+91-9876543211',
      vehicle: 'MH-12-CD-5678', license: 'DL-1420110054321', lat: 18.5314, lng: 73.8446 },
    { name: 'Anil Deshmukh',  email: 'driver3@goldenhour.com', phone: '+91-9876543212',
      vehicle: 'MH-12-EF-9012', license: 'DL-1420110098765', lat: 18.5089, lng: 73.8278 },
    { name: 'Vikas More',     email: 'driver4@goldenhour.com', phone: '+91-9876543213',
      vehicle: 'MH-12-GH-3456', license: 'DL-1420110011223', lat: 18.4575, lng: 73.8525 },
    { name: 'Pravin Jadhav',  email: 'driver5@goldenhour.com', phone: '+91-9876543214',
      vehicle: 'MH-12-IJ-7890', license: 'DL-1420110099887', lat: 18.4490, lng: 73.8580 },
    { name: 'Sneha Kulkarni', email: 'driver6@goldenhour.com', phone: '+91-9876543215',
      vehicle: 'MH-14-KL-2468', license: 'DL-1420110076543', lat: 18.5450, lng: 73.8700 },
  ];

  for (const d of drivers) {
    insertUser.run(
      'driver', d.name, d.email, d.phone, hash('driver123'),
      d.vehicle, d.license, null, null,
      d.lat, d.lng, 1
    );
  }

  // ─── Hospitals — real Pune hospitals across the city + Katraj/South Pune ──
  // Mix of tertiary / multispecialty / general so AI matching has real choices.
  const hospitals = [
    { name: 'Dr. Priya Sharma',   email: 'rubyhall@goldenhour.com',  phone: '+91-2026051001',
      org: 'Ruby Hall Clinic',                 address: '40 Sassoon Road, Pune 411001',
      lat: 18.5314, lng: 73.8770, tier: 'tertiary' },
    { name: 'Dr. Amit Mehta',     email: 'jehangir@goldenhour.com', phone: '+91-2026051002',
      org: 'Jehangir Hospital',                address: '32 Sassoon Road, Pune 411001',
      lat: 18.5275, lng: 73.8755, tier: 'multispecialty' },
    { name: 'Dr. Sunita Rao',     email: 'sahyadri@goldenhour.com', phone: '+91-2026051003',
      org: 'Sahyadri Hospital Deccan',         address: 'Plot 30-C, Erandwane, Pune 411004',
      lat: 18.5170, lng: 73.8313, tier: 'multispecialty' },
    { name: 'Dr. Rakesh Joshi',   email: 'deenanath@goldenhour.com', phone: '+91-2026051004',
      org: 'Deenanath Mangeshkar Hospital',    address: 'Erandwane, Pune 411004',
      lat: 18.5089, lng: 73.8278, tier: 'tertiary' },
    { name: 'Dr. Meena Kulkarni', email: 'bharati@goldenhour.com',  phone: '+91-2026051005',
      org: 'Bharati Hospital Katraj',          address: 'Dhankawadi, Katraj, Pune 411043',
      lat: 18.4583, lng: 73.8531, tier: 'tertiary' },
    { name: 'Dr. Sanjay Patil',   email: 'adinath@goldenhour.com',  phone: '+91-2026051006',
      org: 'Adinath Multispeciality Katraj',   address: 'Katraj-Kondhwa Road, Katraj, Pune 411046',
      lat: 18.4490, lng: 73.8602, tier: 'multispecialty' },
    { name: 'Dr. Vivek Sharma',   email: 'kem@goldenhour.com',      phone: '+91-2026051007',
      org: 'KEM Hospital Rasta Peth',          address: '489 Rasta Peth, Sardar Moodliar Road, Pune 411011',
      lat: 18.5158, lng: 73.8741, tier: 'multispecialty' },
    { name: 'Dr. Anjali Desai',   email: 'noble@goldenhour.com',    phone: '+91-2026051008',
      org: 'Noble Hospital Hadapsar',          address: 'Magarpatta City Road, Hadapsar, Pune 411013',
      lat: 18.4889, lng: 73.9259, tier: 'multispecialty' },
    { name: 'Dr. Ramesh Gupta',   email: 'sassoon@goldenhour.com',  phone: '+91-2026051009',
      org: 'Sassoon General Hospital',         address: 'Sassoon Road, Pune 411001',
      lat: 18.5295, lng: 73.8744, tier: 'general' },
  ];

  for (const h of hospitals) {
    const result = insertUser.run(
      'hospital', h.name, h.email, h.phone, hash('hospital123'),
      null, null, h.org, h.address,
      h.lat, h.lng, 1
    );
    const hospitalId = result.lastInsertRowid;
    const tier = HOSPITAL_TIERS[h.tier];

    // Insert capabilities
    for (const cap of tier.capabilities) insertCap.run(hospitalId, cap);

    // Insert beds — one row per bed instance for atomic reservation
    for (const [bedType, count] of Object.entries(tier.beds)) {
      for (let i = 1; i <= count; i++) {
        const label = `${bedType.toUpperCase()}-${i.toString().padStart(2, '0')}`;
        // Pre-occupy ~30% of beds to make inventory look realistic.
        // 🤔 ASSUMPTION: real hospitals are never empty — pre-fill for demo realism.
        const preOccupy = Math.random() < 0.3;
        insertBed.run(hospitalId, bedType, label, preOccupy ? 'occupied' : 'available');
      }
    }
  }

  // ─── Blood banks — name-based emails for easy login ───────────
  const bloodbanks = [
    { name: 'Janakalyan Blood Bank',   email: 'janakalyan@goldenhour.com',  phone: '+91-2026052001',
      org: 'Janakalyan Raktapedhi',                address: 'Karve Road, Pune 411004',
      lat: 18.5089, lng: 73.8345 },
    { name: 'Sassoon Blood Bank',      email: 'sassoonbb@goldenhour.com', phone: '+91-2026052002',
      org: 'Sassoon General Hospital Blood Bank',  address: 'Sassoon Road, Pune 411001',
      lat: 18.5295, lng: 73.8744 },
    { name: 'Deenanath Blood Bank',    email: 'deenanathbb@goldenhour.com', phone: '+91-2026052003',
      org: 'Deenanath Mangeshkar Blood Bank',      address: 'Erandwane, Pune 411004',
      lat: 18.5089, lng: 73.8278 },
    { name: 'Bharati Blood Bank',      email: 'bharatibb@goldenhour.com', phone: '+91-2026052004',
      org: 'Bharati Hospital Blood Bank Katraj',   address: 'Dhankawadi, Katraj, Pune 411043',
      lat: 18.4583, lng: 73.8531 },
    { name: 'KEM Blood Bank',          email: 'kembb@goldenhour.com', phone: '+91-2026052005',
      org: 'KEM Hospital Blood Bank',              address: 'Rasta Peth, Pune 411011',
      lat: 18.5158, lng: 73.8741 },
  ];

  for (const b of bloodbanks) {
    insertUser.run(
      'bloodbank', b.name, b.email, b.phone, hash('blood123'),
      null, null, b.org, b.address,
      b.lat, b.lng, 1
    );
  }

  const total = drivers.length + hospitals.length + bloodbanks.length;
  console.log(`[seed] ✅ Seeded ${total} demo users`);
  console.log(`[seed]    ${drivers.length} drivers · ${hospitals.length} hospitals · ${bloodbanks.length} blood banks`);
  console.log(`[seed]    Bed inventory + capabilities populated`);
  console.log('[seed] ───────────── DEMO CREDENTIALS ─────────────');
  console.log('[seed] DRIVERS (password: driver123)');
  for (const d of drivers) console.log(`         ${d.email}  →  ${d.name}`);
  console.log('[seed] HOSPITALS (password: hospital123)');
  for (const h of hospitals) console.log(`         ${h.email}  →  ${h.org}`);
  console.log('[seed] BLOOD BANKS (password: blood123)');
  for (const b of bloodbanks) console.log(`         ${b.email}  →  ${b.org}`);
  console.log('[seed] ─────────────────────────────────────────────');
}

if (require.main === module) seed();
module.exports = seed;
