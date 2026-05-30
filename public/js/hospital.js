// public/js/hospital.js
// Hospital operations console — bed inventory, incoming cases with AI triage,
// live ambulance tracking, blood-bank ETA display.

if (!RA.Auth.requireRole('hospital')) throw new Error('auth');

const user = RA.Auth.user;
document.getElementById('user-name').textContent = user.name || 'Hospital';
document.getElementById('user-org').textContent = user.org_name || user.email || '—';
document.getElementById('avatar').textContent = (user.org_name || user.name || 'H').charAt(0).toUpperCase();

setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB');
}, 1000);

// ── Socket ─────────────────────────────────────────────────────
const socket = io({ auth: { token: RA.Auth.token } });
socket.on('connect', () => console.log('[socket] connected'));

socket.on('emergency:new', (data) => {
  RA.toast('Incoming Emergency', `${data.emergency.request_code} dispatched`, 'warning');
  refreshAll();
});

socket.on('emergency:incoming', (data) => {
  const { emergency, ai, match } = data;
  const bedLabel = match?.bed?.label || ai?.required_bed_type?.toUpperCase() || '?';
  RA.toast(
    `INCOMING · ${emergency.request_code}`,
    `${ai?.severity?.toUpperCase()} · ${ai?.injury_type} · ${bedLabel}${match?.fallbackUsed ? ' (alt)' : ''}`,
    'warning', 10000
  );
  refreshAll();
});

socket.on('emergency:update', (data) => {
  refreshAll();
  if (data.emergency && data.emergency.status === 'hospital_reached') {
    RA.toast('Patient Arrived', `${data.emergency.request_code} reached hospital`, 'success');
  }
});

socket.on('driver:location', (data) => {
  updateDriverMarker(data.driver_id, data.lat, data.lng);
});

socket.on('beds:update', (data) => {
  if (data && data.beds) { currentBeds = data.beds; renderBeds(); }
});

socket.on('blood:response', (data) => {
  const bank = data.bloodbank_name || 'Blood bank';
  const msg = data.eta_minutes
    ? `${bank}: dispatched · ETA ${data.eta_minutes} min`
    : `${bank}: ${data.status}`;
  RA.toast('Blood Update', msg, 'success', 6000);
  refreshAll();
});

// ── Map ────────────────────────────────────────────────────────
let map;
const driverMarkers = new Map();   // driver_id -> { marker, lat, lng }
const victimMarkers = new Map();   // emergency_id -> marker
const routeLines = new Map();      // emergency_id -> polyline
let driversById = new Map();

const HOSPITAL_LAT = user.lat || 18.5204;
const HOSPITAL_LNG = user.lng || 73.8567;

function emojiIcon(emoji, size = 34) {
  return L.divIcon({
    className: 'emoji-marker',
    html: `<div style="font-size:${size}px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));text-align:center;">${emoji}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

(function initMap() {
  map = L.map('hospital-map', { zoomControl: true }).setView([HOSPITAL_LAT, HOSPITAL_LNG], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);

  L.marker([HOSPITAL_LAT, HOSPITAL_LNG], { icon: emojiIcon('🏥', 36), zIndexOffset: 500 })
    .addTo(map).bindPopup(`<strong>${RA.escapeHtml(user.org_name || 'Hospital')}</strong>`);
})();

function updateDriverMarker(driverId, lat, lng) {
  const existing = driverMarkers.get(driverId);
  if (existing) {
    existing.marker.setLatLng([lat, lng]);
    existing.lat = lat; existing.lng = lng;
  } else {
    const marker = L.marker([lat, lng], { icon: emojiIcon('🚑', 32), zIndexOffset: 1000 }).addTo(map);
    const d = driversById.get(driverId);
    if (d) marker.bindPopup(`<strong>${RA.escapeHtml(d.name)}</strong><br>${RA.escapeHtml(d.vehicle_number || '')}`);
    driverMarkers.set(driverId, { marker, lat, lng });
  }
}

async function refreshDrivers() {
  try {
    const { drivers } = await RA.api('/api/users/drivers');
    driversById = new Map((drivers || []).map(d => [d.id, d]));
    (drivers || []).forEach(d => { if (d.lat && d.lng) updateDriverMarker(d.id, d.lat, d.lng); });
  } catch (err) { console.warn('drivers refresh failed', err); }
}

// ── Bed inventory (interactive individual beds) ────────────────
const BED_TYPE_LABELS = {
  general: 'General', icu: 'ICU', emergency: 'Emergency', operation: 'OT',
  trauma: 'Trauma', burn: 'Burns', cardiac: 'Cardiac', pediatric: 'Pediatric', maternity: 'Maternity'
};

let currentBeds = [];

async function refreshBeds() {
  try {
    const { beds } = await RA.api('/api/emergency/beds/list');
    currentBeds = beds || [];
    renderBeds();
  } catch (err) { console.warn('beds refresh failed', err); }
}

function renderBeds() {
  const grid = document.getElementById('beds-grid');
  if (!currentBeds.length) {
    grid.innerHTML = `<div class="muted text-sm" style="grid-column: 1 / -1; text-align: center; padding: 16px;">No bed inventory configured.</div>`;
    document.getElementById('beds-summary').textContent = '—';
    return;
  }

  const avail = currentBeds.filter(b => b.status === 'available').length;
  const reserved = currentBeds.filter(b => b.status === 'reserved').length;
  const occupied = currentBeds.filter(b => b.status === 'occupied').length;
  document.getElementById('beds-summary').textContent =
    `🟢 ${avail} free · 🟡 ${reserved} incoming · 🔴 ${occupied} occupied`;

  // Group beds by type
  const byType = {};
  for (const b of currentBeds) {
    (byType[b.bed_type] = byType[b.bed_type] || []).push(b);
  }

  const colorFor = (s) => s === 'available' ? '#16a34a' : (s === 'reserved' ? '#eab308' : '#dc2626');
  const bgFor    = (s) => s === 'available' ? 'rgba(22,163,74,0.12)' : (s === 'reserved' ? 'rgba(234,179,8,0.14)' : 'rgba(220,38,38,0.12)');

  grid.style.display = 'block';
  grid.innerHTML = Object.keys(byType).map(type => {
    const cells = byType[type].map((b, i) => {
      const c = colorFor(b.status);
      // Clicking cycles the status. Reserved → occupied (patient arrived).
      const nextStatus = b.status === 'available' ? 'occupied'
                       : b.status === 'occupied' ? 'available'
                       : 'occupied';  // reserved → occupied (mark patient arrived)
      const tip = b.status === 'reserved'
        ? `${b.request_code || 'Incoming'} — ambulance en-route · click to mark patient arrived`
        : (b.status === 'occupied' ? `${b.request_code || 'Occupied'} · click to free` : 'Available · click to mark occupied');
      return `
        <button title="${tip}"
          onclick="toggleBed(${b.id}, '${nextStatus}')"
          style="width:34px;height:34px;border-radius:8px;border:1.5px solid ${c};
                 background:${bgFor(b.status)};color:${c};font-size:0.6rem;font-weight:700;
                 cursor:pointer;display:grid;place-items:center;
                 font-family:var(--font-mono);transition:all .15s;"
          onmouseover="this.style.transform='scale(1.12)'" onmouseout="this.style.transform='scale(1)'">
          ${b.status === 'reserved' ? '🚑' : (b.status === 'occupied' ? '●' : i + 1)}
        </button>`;
    }).join('');
    return `
      <div style="margin-bottom:14px;">
        <div style="font-family:var(--font-mono);font-size:0.65rem;letter-spacing:0.08em;color:var(--text-2);text-transform:uppercase;margin-bottom:6px;">
          ${BED_TYPE_LABELS[type] || type} <span style="opacity:0.6;">(${byType[type].filter(x=>x.status==='available').length}/${byType[type].length})</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${cells}</div>
      </div>`;
  }).join('') + `
    <div style="display:flex;gap:16px;margin-top:8px;font-size:0.7rem;color:var(--text-2);flex-wrap:wrap;">
      <span>🟢 Available</span>
      <span>🟡 🚑 Reserved (ambulance incoming)</span>
      <span>🔴 Occupied</span>
      <span style="opacity:0.7;">Click any bed to change its status</span>
    </div>`;
}

async function toggleBed(bedId, newStatus) {
  try {
    const { beds } = await RA.api(`/api/emergency/beds/${bedId}/toggle`, { method: 'POST', body: { status: newStatus } });
    currentBeds = beds || currentBeds;
    renderBeds();
  } catch (err) {
    RA.toast('Error', err.message, 'warning');
  }
}
window.toggleBed = toggleBed;

// ── Emergencies ────────────────────────────────────────────────
let currentEmergencies = [];

async function refreshEmergencies() {
  try {
    const { emergencies } = await RA.api('/api/emergency/list');
    currentEmergencies = emergencies || [];
    renderEmergencyList();
    renderBloodList();
    updateKpis();
    syncMapMarkers();
  } catch (err) { console.warn('emergencies refresh failed', err); }
}

function updateKpis() {
  const active = currentEmergencies.filter(e => ['requested','accepted','reached','picked'].includes(e.status));
  const inbound = currentEmergencies.filter(e => ['accepted','reached','picked'].includes(e.status));
  const today = new Date(); today.setHours(0,0,0,0);
  const toDate = s => s ? new Date(s.replace(' ', 'T')) : new Date(0);
  const arrived = currentEmergencies.filter(e => e.status === 'hospital_reached' && toDate(e.created_at) >= today);
  const critical = currentEmergencies.filter(e => e.severity === 'critical' && e.status !== 'hospital_reached');

  document.getElementById('kpi-active').textContent = active.length;
  document.getElementById('kpi-inbound').textContent = inbound.length;
  document.getElementById('kpi-arrived').textContent = arrived.length;
  document.getElementById('kpi-critical').textContent = critical.length;
  document.getElementById('incoming-count').textContent = `${active.length} active`;
}

function renderEmergencyList() {
  const list = document.getElementById('emergency-list');
  const active = currentEmergencies.filter(e => e.status !== 'hospital_reached' && e.status !== 'cancelled');

  if (!active.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🩺</div>
        <div class="empty-state-title">No active emergencies</div>
        <div class="empty-state-body">When a driver accepts a 112 dispatch and uploads a photo from the scene, you'll see the incoming case here.</div>
      </div>`;
    return;
  }

  list.innerHTML = active.map(e => {
    const driver = e.driver_name ? `${RA.escapeHtml(e.driver_name)} · ${RA.escapeHtml(e.vehicle_number || '')}` : '<em style="opacity:0.7;">Awaiting driver acceptance</em>';
    const dist = e.driver_lat ? RA.distanceKm(e.driver_lat, e.driver_lng, HOSPITAL_LAT, HOSPITAL_LNG) : null;
    const eta = dist != null ? RA.etaMinutes(dist) : null;
    const isCritical = e.severity === 'critical' || ['severe','critical'].includes(e.ai_severity);
    const hasAi = !!e.ai_summary;

    // Large media block if we have a photo, otherwise compact placeholder
    let photoHtml = '';
    if (e.media_path) {
      photoHtml = e.media_type === 'video'
        ? `<div class="incoming-photo"><video src="${e.media_path}" controls muted></video></div>`
        : `<div class="incoming-photo"><img src="${e.media_path}" alt="Injury photo"></div>`;
    } else {
      photoHtml = `<div class="incoming-photo incoming-photo-empty">📷 Photo will appear after driver uploads at scene</div>`;
    }

    // AI panel
    let aiHtml = '';
    if (hasAi) {
      const sevColor = isCritical ? 'var(--accent)' : 'var(--info)';
      aiHtml = `
        <div class="incoming-ai" style="border-color: color-mix(in srgb, ${sevColor} 30%, transparent); background: color-mix(in srgb, ${sevColor} 7%, var(--bg-3));">
          <div class="incoming-ai-label" style="color:${sevColor};">
            AI TRIAGE · ${e.ai_severity?.toUpperCase()} · ${Math.round((e.ai_confidence||0)*100)}% conf.
          </div>
          <div class="incoming-ai-summary">${RA.escapeHtml(e.ai_summary)}</div>
          <div class="incoming-ai-meta">
            ${e.ai_injury_type ? '<span>🩹 ' + RA.escapeHtml(e.ai_injury_type) + '</span>' : ''}
            ${e.reserved_bed_label ? '<span>🛏 ' + e.reserved_bed_label + '</span>' : (e.ai_required_bed_type ? '<span>🛏 ' + e.ai_required_bed_type + '</span>' : '')}
            ${e.ai_blood_group ? '<span>🩸 ' + e.ai_blood_group + ' × ' + e.ai_blood_units + '</span>' : ''}
          </div>
        </div>`;
    } else {
      aiHtml = `<div class="incoming-ai incoming-ai-pending"><span class="dot-pulse"></span> Awaiting AI triage from scene…</div>`;
    }

    return `
      <div class="incoming-card ${isCritical ? 'critical' : ''}" data-detail="${e.id}"
           data-elat="${e.driver_lat || ''}" data-elng="${e.driver_lng || ''}"
           style="cursor:pointer;">
        <div class="incoming-head">
          <div>
            <div class="incoming-code">${RA.escapeHtml(e.request_code)}</div>
            <div class="incoming-driver">${driver}</div>
          </div>
          <div class="incoming-status">
            ${RA.statusPill(e.status)}
            ${isCritical ? '<span class="badge-critical" style="margin-top:6px;display:inline-block;">CRITICAL</span>' : ''}
          </div>
        </div>
        ${photoHtml}
        ${aiHtml}
        <div class="incoming-foot">
          <span class="mono text-xs muted">
            ${dist != null ? '🚑 <span id="hosp-eta-' + e.id + '">' + dist.toFixed(1) + ' km · ETA ' + eta + ' min</span> · ' : ''}${RA.timeAgo(e.created_at)}
          </span>
          <button class="btn btn-sm btn-ghost">${e.driver_lat ? '📍 Track on map' : 'View details →'}</button>
        </div>
      </div>
    `;
  }).join('');

  // Click a card → pan/zoom the map to that ambulance
  list.querySelectorAll('[data-detail]').forEach(card => {
    card.addEventListener('click', () => {
      const lat = parseFloat(card.dataset.elat), lng = parseFloat(card.dataset.elng);
      if (!isNaN(lat) && !isNaN(lng) && map) {
        map.flyTo([lat, lng], 15, { duration: 0.8 });
        const dm = driverMarkers.get(parseInt(card.dataset.detail));
        document.getElementById('hospital-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  list.querySelectorAll('[data-detail]').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.detail));
  });
}

function renderBloodList() {
  const list = document.getElementById('blood-list');
  const blood = currentEmergencies.filter(e => e.severity === 'critical' || e.blood_required);
  if (!blood.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🩸</div>
        <div class="empty-state-title">No blood alerts active</div>
        <div class="empty-state-body">Critical cases with blood needs will automatically broadcast here.</div>
      </div>`;
    return;
  }
  list.innerHTML = blood.map(e => {
    const group = e.blood_required || e.ai_blood_group || '?';
    const units = e.blood_units_required || e.ai_blood_units || 1;
    return `
      <div class="emergency-row critical" data-detail="${e.id}">
        <div class="blood-badge">${RA.escapeHtml(group)}</div>
        <div class="em-info">
          <div class="em-code">${RA.escapeHtml(e.request_code)} · ${units} unit${units > 1 ? 's' : ''}</div>
          <div class="em-title">${RA.escapeHtml(e.ai_summary || e.notes || 'Blood requested')}</div>
          <div class="em-sub">${RA.timeAgo(e.created_at)}</div>
        </div>
        <div class="em-actions">${RA.statusPill(e.status)}</div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-detail]').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.detail));
  });
}

function syncMapMarkers() {
  const activeIds = new Set();
  currentEmergencies
    .filter(e => ['requested','accepted','reached','picked'].includes(e.status))
    .forEach(e => {
      activeIds.add(e.id);
      if (!victimMarkers.has(e.id) && e.reporter_lat && e.reporter_lng) {
        const m = L.marker([e.reporter_lat, e.reporter_lng], {
          icon: L.divIcon({ className: 'victim-marker', iconSize: [20, 20] })
        }).addTo(map).bindPopup(`<strong>${RA.escapeHtml(e.request_code)}</strong><br>${RA.escapeHtml(e.status)}`);
        victimMarkers.set(e.id, m);
      }
      const driverInfo = e.assigned_driver_id ? driverMarkers.get(e.assigned_driver_id) : null;
      const pts = [];
      if (driverInfo) pts.push([driverInfo.lat, driverInfo.lng]);
      pts.push([e.reporter_lat, e.reporter_lng]);
      pts.push([HOSPITAL_LAT, HOSPITAL_LNG]);

      if (routeLines.has(e.id)) {
        routeLines.get(e.id).setLatLngs(pts);
      } else if (pts.length >= 2) {
        const line = L.polyline(pts, {
          color: e.severity === 'critical' ? '#ef3e42' : '#0ea5e9',
          weight: 3, dashArray: '6 8', opacity: 0.8
        }).addTo(map);
        routeLines.set(e.id, line);
      }
    });

  for (const [id, m] of victimMarkers) if (!activeIds.has(id)) { map.removeLayer(m); victimMarkers.delete(id); }
  for (const [id, l] of routeLines)   if (!activeIds.has(id)) { map.removeLayer(l); routeLines.delete(id); }
}

// ── Detail modal ───────────────────────────────────────────────
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
function closeModal() { modal.classList.remove('show'); }

async function openDetail(id) {
  try {
    const { emergency } = await RA.api(`/api/emergency/${id}`);
    const e = emergency;

    const mediaHtml = e.media_path
      ? (e.media_type === 'video'
          ? `<video src="${e.media_path}" controls class="modal-media"></video>`
          : `<img src="${e.media_path}" alt="" class="modal-media">`)
      : `<div class="modal-media modal-media-empty">📷 No photo uploaded yet</div>`;

    const driverDist = e.driver_lat ? RA.distanceKm(e.driver_lat, e.driver_lng, HOSPITAL_LAT, HOSPITAL_LNG) : null;
    const driverEta = driverDist != null ? RA.etaMinutes(driverDist) : null;

    const aiHtml = e.ai_summary ? `
      <div style="margin-top:14px; padding:14px; background: color-mix(in srgb, ${['severe','critical'].includes(e.ai_severity) ? 'var(--accent)' : 'var(--info)'} 8%, var(--bg-3)); border-radius: var(--radius-md); border: 1px solid color-mix(in srgb, ${['severe','critical'].includes(e.ai_severity) ? 'var(--accent)' : 'var(--info)'} 25%, transparent);">
        <div class="mono text-xs" style="color: ${['severe','critical'].includes(e.ai_severity) ? 'var(--accent)' : 'var(--info)'}; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px;">
          AI Triage · ${e.ai_severity?.toUpperCase()} · ${Math.round((e.ai_confidence || 0) * 100)}% conf.
        </div>
        <div style="font-size: 0.95rem;">${RA.escapeHtml(e.ai_summary)}</div>
        <div class="mono text-xs muted" style="margin-top: 8px;">
          ${e.ai_injury_type ? 'Injury: ' + e.ai_injury_type + ' · ' : ''}
          ${e.reserved_bed_label ? 'Bed: ' + e.reserved_bed_label + ' · ' : (e.ai_required_bed_type ? 'Type: ' + e.ai_required_bed_type + ' · ' : '')}
          ${e.ai_blood_group ? 'Blood: ' + e.ai_blood_group + ' × ' + e.ai_blood_units : ''}
        </div>
      </div>` : '';

    modalBody.innerHTML = `
      <div class="modal-head">
        <div>
          <div class="em-code">${RA.escapeHtml(e.request_code)}</div>
          <h3 style="margin-top:4px;">${['severe','critical'].includes(e.ai_severity) ? 'Critical <em>case</em>' : 'Inbound <em>case</em>'}</h3>
        </div>
        <button class="btn btn-ghost btn-sm" id="close-modal">Close</button>
      </div>
      ${mediaHtml}
      ${aiHtml}
      <div style="margin-top:18px;">${RA.workflowHtml(e.status)}</div>
      <div class="grid-2" style="margin-top:18px;">
        <div><div class="text-xs muted mono">STATUS</div>${RA.statusPill(e.status)}</div>
        <div><div class="text-xs muted mono">SEVERITY</div><strong>${e.severity === 'critical' ? '<span style="color:var(--accent)">CRITICAL</span>' : 'Normal'}</strong></div>
        <div><div class="text-xs muted mono">DRIVER</div><strong>${RA.escapeHtml(e.driver_name || '—')}</strong></div>
        <div><div class="text-xs muted mono">VEHICLE</div><strong class="mono">${RA.escapeHtml(e.vehicle_number || '—')}</strong></div>
        <div><div class="text-xs muted mono">DISTANCE</div><strong>${driverDist != null ? driverDist.toFixed(1) + ' km' : '—'}</strong></div>
        <div><div class="text-xs muted mono">ETA</div><strong>${driverEta != null ? driverEta + ' min' : '—'}</strong></div>
        <div><div class="text-xs muted mono">REPORTED</div><strong>${RA.timeAgo(e.created_at)}</strong></div>
        <div><div class="text-xs muted mono">BED</div><strong>${RA.escapeHtml(e.reserved_bed_label || '—')}</strong></div>
      </div>
      ${!e.ai_completed_at ? `
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);">
          <button class="btn btn-primary btn-block" id="raise-blood">Raise Manual Blood Alert</button>
        </div>` : ''}
    `;

    modal.classList.add('show');
    document.getElementById('close-modal').addEventListener('click', closeModal);
    const raiseBtn = document.getElementById('raise-blood');
    if (raiseBtn) raiseBtn.addEventListener('click', () => openBloodForm(e));
  } catch (err) { RA.toast('Error', err.message, 'warning'); }
}

function openBloodForm(e) {
  modalBody.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="em-code">BLOOD ALERT · ${RA.escapeHtml(e.request_code)}</div>
        <h3 style="margin-top:4px;">Notify blood <em>banks</em></h3>
      </div>
      <button class="btn btn-ghost btn-sm" id="close-modal">Close</button>
    </div>
    <p class="muted" style="margin-top:8px;">This will mark the case as critical and broadcast to all nearby blood banks.</p>
    <div class="field" style="margin-top:14px;">
      <label>Blood Group</label>
      <select id="blood-group">
        <option value="A+">A+</option><option value="A-">A-</option>
        <option value="B+">B+</option><option value="B-">B-</option>
        <option value="AB+">AB+</option><option value="AB-">AB-</option>
        <option value="O+" selected>O+</option><option value="O-">O-</option>
      </select>
    </div>
    <div class="field">
      <label>Units required</label>
      <input type="number" id="blood-units" min="1" max="20" value="2">
    </div>
    <div class="field">
      <label>Notes (optional)</label>
      <input type="text" id="blood-notes" placeholder="e.g. trauma, urgent surgery">
    </div>
    <button class="btn btn-primary btn-block" style="margin-top:10px;" id="send-blood">Send Alert</button>
  `;
  modal.classList.add('show');
  document.getElementById('close-modal').addEventListener('click', closeModal);
  document.getElementById('send-blood').addEventListener('click', async () => {
    const blood_group = document.getElementById('blood-group').value;
    const units_required = parseInt(document.getElementById('blood-units').value) || 1;
    const notes = document.getElementById('blood-notes').value;
    try {
      await RA.api(`/api/emergency/${e.id}/blood-alert`, {
        method: 'POST',
        body: { blood_group, units_required, notes }
      });
      RA.toast('Alert sent', `Blood banks notified · ${blood_group}`, 'success');
      closeModal();
      refreshAll();
    } catch (err) { RA.toast('Error', err.message, 'warning'); }
  });
}

window.openBloodModal = function () {
  const candidate = currentEmergencies.find(e =>
    e.severity !== 'critical' &&
    ['accepted','reached','picked','requested'].includes(e.status)
  );
  if (!candidate) {
    RA.toast('No active case', 'Open a specific emergency to raise its blood alert.', 'warning');
    return;
  }
  openBloodForm(candidate);
};

// ── Refresh loop ───────────────────────────────────────────────
function refreshAll() {
  refreshDrivers();
  refreshEmergencies();
  refreshBeds();
}
refreshAll();
setInterval(refreshAll, 12000);

// ── Live ETA ticker — updates each incoming card from the ambulance's
//    live map position every second (Uber-style countdown).
setInterval(() => {
  for (const e of currentEmergencies) {
    const span = document.getElementById('hosp-eta-' + e.id);
    if (!span) continue;
    const dm = driverMarkers.get(e.assigned_driver_id);
    let lat = e.driver_lat, lng = e.driver_lng;
    if (dm) { lat = dm.lat; lng = dm.lng; }
    if (lat == null || lng == null) continue;
    const km = RA.distanceKm(lat, lng, HOSPITAL_LAT, HOSPITAL_LNG);
    const sec = Math.max(0, Math.round((km / 35) * 3600));
    const mm = Math.floor(sec / 60), ss = sec % 60;
    span.textContent = `${km.toFixed(1)} km · ETA ${mm > 0 ? mm + ' min ' : ''}${ss.toString().padStart(2,'0')}s`;
  }
}, 1000);
