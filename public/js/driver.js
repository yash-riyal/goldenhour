// public/js/driver.js — Mobile-first driver console.
// One scrolling column with sticky tabs that scroll-snap to sections.

if (!RA.Auth.requireRole('driver')) throw new Error('auth');

const user = RA.Auth.user;
document.getElementById('user-name').textContent = user.name || 'Driver';
document.getElementById('user-vehicle').textContent = user.vehicle_number || '—';
document.getElementById('avatar').textContent = (user.name || 'D')[0].toUpperCase();

// ── Clock ──────────────────────────────────────────────────
setInterval(() => {
  const c = document.getElementById('clock');
  if (c) c.textContent = new Date().toLocaleTimeString('en-GB');
}, 1000);

// ── Socket ─────────────────────────────────────────────────
const socket = io({ auth: { token: RA.Auth.token } });
socket.on('connect', () => console.log('[socket] connected'));

socket.on('sos:new', (data) => {
  addSos(data);
  RA.toast(RA.t('driver.toast.sosIncoming') || 'SOS Incoming', `${data.emergency.request_code} · ${data.distance_km?.toFixed(1)} km`, 'warning', 15000);
  scrollToTab('sos');
});

socket.on('sos:auto_assigned', (data) => {
  RA.toast('Auto-assigned', `Nearest driver — ${data.emergency.request_code}`, 'success', 6000);
  refresh();
  scrollToTab('active');
});

socket.on('emergency:new', (data) => {
  // Legacy event from older flow; treat as SOS.
  if (data.emergency) {
    addSos({
      emergency: data.emergency,
      distance_km: data.distance_km || 0,
      eta_minutes: data.eta_minutes || 0,
      expires_at: Date.now() + 15000,
      window_ms: 15000
    });
  }
});

socket.on('emergency:update', (data) => {
  refresh();
  // If our active case got an AI update, the map + active section will refresh via refresh().
  const em = data.emergency;
  if (em && em.assigned_driver_id === user.id && em.status === 'hospital_reached') {
    RA.toast('Case complete', `${em.request_code} marked at hospital`, 'success');
  }
});

// ── GPS push every 8s ──────────────────────────────────────
let myLat = user.lat || 18.5204;
let myLng = user.lng || 73.8567;

function pushGps() {
  if (!navigator.geolocation) {
    socket.emit('driver:gps', { lat: myLat, lng: myLng });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLat = pos.coords.latitude;
      myLng = pos.coords.longitude;
      socket.emit('driver:gps', { lat: myLat, lng: myLng });
      if (driverMarker) driverMarker.setLatLng([myLat, myLng]);
      recomputeRoute();
    },
    () => { socket.emit('driver:gps', { lat: myLat, lng: myLng }); },
    { enableHighAccuracy: true, timeout: 5000 }
  );
}
pushGps();
setInterval(pushGps, 8000);

// ── Availability pill toggle ───────────────────────────────
const availPill = document.getElementById('avail-pill');
const availLabel = document.getElementById('avail-label');
let isAvailable = true;
availPill.addEventListener('click', async () => {
  isAvailable = !isAvailable;
  availPill.classList.toggle('on', isAvailable);
  availPill.classList.toggle('off', !isAvailable);
  availLabel.textContent = isAvailable ? 'ON DUTY' : 'OFF DUTY';
  try {
    await RA.api('/api/users/availability', { method: 'POST', body: { is_available: isAvailable } });
  } catch (err) { RA.toast('Error', err.message, 'warning'); }
});

// ── Tab strip — scroll-snap to sections ────────────────────
const tabs = document.querySelectorAll('.tab-btn');
tabs.forEach(t => {
  t.addEventListener('click', () => scrollToTab(t.dataset.target));
});

function scrollToTab(target) {
  const el = document.getElementById('sec-' + target);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  tabs.forEach(t => t.classList.toggle('active', t.dataset.target === target));
}

// IntersectionObserver — update active tab as user scrolls
const sections = ['sos', 'active', 'map', 'history', 'settings'];
const sectionObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      const target = entry.target.id.replace('sec-', '');
      tabs.forEach(t => t.classList.toggle('active', t.dataset.target === target));
    }
  }
}, { rootMargin: '-40% 0px -50% 0px' });

sections.forEach(s => {
  const el = document.getElementById('sec-' + s);
  if (el) sectionObserver.observe(el);
});

// ── SOS card management ────────────────────────────────────
// In-memory map of currently-displayed SOS cards: emergency_id -> { el, intervalId }
const sosCards = new Map();

function addSos(data) {
  const em = data.emergency;
  if (!em || sosCards.has(em.id)) return;
  if (em.assigned_driver_id) return; // already taken

  const expiresAt = data.expires_at || (Date.now() + (data.window_ms || 15000));
  const totalMs = data.window_ms || 15000;

  const list = document.getElementById('sos-list');
  // Clear placeholder
  const sub = document.getElementById('sos-sub');
  if (sub) sub.style.display = 'none';

  const card = document.createElement('div');
  card.className = 'sos-card';
  card.dataset.emergencyId = em.id;
  card.innerHTML = `
    <div class="sos-banner"><span class="dot"></span> ${RA.t('driver.banner') || 'SOS · Accident detected · 112'}</div>
    <div class="sos-code">${RA.escapeHtml(em.request_code)}</div>
    <div class="sos-meta">
      <div class="kv"><strong>${(data.distance_km || 0).toFixed(1)} km</strong><span>${RA.t('label.distance') || 'Distance'}</span></div>
      <div class="kv"><strong>${data.eta_minutes || '—'} min</strong><span>${RA.t('label.eta') || 'ETA'}</span></div>
      <div class="kv"><strong id="sos-timer-${em.id}">15s</strong><span>${RA.t('driver.sos.decide') || 'Decide in'}</span></div>
    </div>
    <div class="sos-countdown-track"><div class="sos-countdown-bar" id="sos-bar-${em.id}"></div></div>
    <div class="sos-actions">
      <button class="btn btn-primary" data-action="accept" data-id="${em.id}">${RA.t('btn.accept') || 'Accept'}</button>
      <button class="btn btn-outline" data-action="reject" data-id="${em.id}">${RA.t('btn.reject') || 'Reject'}</button>
    </div>
  `;
  list.prepend(card);

  // Countdown tick
  const intervalId = setInterval(() => {
    const remaining = expiresAt - Date.now();
    const pct = Math.max(0, Math.min(100, (remaining / totalMs) * 100));
    const bar = document.getElementById(`sos-bar-${em.id}`);
    const timer = document.getElementById(`sos-timer-${em.id}`);
    if (bar) bar.style.width = pct + '%';
    if (timer) timer.textContent = Math.max(0, Math.ceil(remaining / 1000)) + 's';
    // Urgency: last 5 seconds, ramp up the visual pressure
    if (remaining < 5000 && !card.classList.contains('sos-urgent')) {
      card.classList.add('sos-urgent');
    }
    if (remaining <= 0) {
      clearInterval(intervalId);
      removeSos(em.id);
    }
  }, 100);

  sosCards.set(em.id, { el: card, intervalId });

  card.querySelector('[data-action="accept"]').addEventListener('click', () => acceptSos(em.id));
  card.querySelector('[data-action="reject"]').addEventListener('click', () => rejectSos(em.id));

  updateSosCount();
}

function removeSos(id) {
  const entry = sosCards.get(id);
  if (!entry) return;
  clearInterval(entry.intervalId);
  entry.el.remove();
  sosCards.delete(id);
  updateSosCount();
  if (sosCards.size === 0) {
    const sub = document.getElementById('sos-sub');
    if (sub) sub.style.display = '';
  }
}

function updateSosCount() {
  const badge = document.getElementById('sos-count');
  if (sosCards.size > 0) {
    badge.textContent = sosCards.size;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

async function acceptSos(id) {
  try {
    await RA.api(`/api/emergency/${id}/accept`, { method: 'POST' });
    RA.toast(RA.t('status.accepted') || 'Accepted', RA.t('driver.toast.accepted') || `You're on your way`, 'success');
    removeSos(id);
    refresh();
    scrollToTab('active');
  } catch (err) {
    RA.toast(RA.t('common.error') || 'Error', err.message, 'warning');
    if (/already_taken|409/i.test(err.message)) removeSos(id);
  }
}

async function rejectSos(id) {
  try {
    await RA.api(`/api/emergency/${id}/reject`, { method: 'POST' });
    removeSos(id);
  } catch (err) { RA.toast('Error', err.message, 'warning'); }
}

// ── Active case rendering ──────────────────────────────────
let activeEmergency = null;
let activeMap = null;
let driverMarker = null, victimMarker = null, hospitalMarker = null, routeLine = null;

function renderActive(em) {
  const wrap = document.getElementById('active-wrap');
  const sub = document.getElementById('active-sub');
  // Only OPEN cases stay in the Active section. A completed case
  // (hospital_reached) drops out of Active and lives only in History.
  if (!em || !['accepted','reached','picked'].includes(em.status)) {
    wrap.innerHTML = '';
    sub.style.display = '';
    activeEmergency = null;
    return;
  }
  sub.style.display = 'none';
  activeEmergency = em;

  // Media block
  let mediaHtml;
  if (em.media_path) {
    mediaHtml = em.media_type === 'video'
      ? `<video src="${em.media_path}" controls></video>`
      : `<img src="${em.media_path}" alt="Scene">`;
  } else {
    mediaHtml = `<div>📷 No photo yet · Reach the scene and upload the injury photo for AI triage.</div>`;
  }

  // AI box
  let aiHtml = '';
  if (em.ai_summary) {
    const sev = (em.ai_severity || '').toLowerCase();
    const isSevere = sev === 'severe' || sev === 'critical';
    aiHtml = `
      <div class="ai-box ${isSevere ? 'severe' : ''}">
        <div class="ai-label">AI Triage · ${(em.ai_severity || '').toUpperCase()} · ${Math.round((em.ai_confidence || 0) * 100)}% conf.</div>
        <div class="ai-summary">${RA.escapeHtml(em.ai_summary)}</div>
        <div class="ai-meta">
          Bed: <strong>${em.reserved_bed_label || em.ai_required_bed_type?.toUpperCase() || '—'}</strong>
          ${em.ai_blood_group ? ` · Blood: <strong>${em.ai_blood_group} × ${em.ai_blood_units}</strong>` : ''}
        </div>
      </div>`;
  }

  // Actions
  const next = { accepted: 'reached', reached: 'picked', picked: 'hospital_reached' }[em.status];
  const labelMap = {
    reached: RA.t('driver.act.reached') || '🚑 Mark Reached',
    picked: RA.t('driver.act.picked') || '🩹 Patient Picked Up',
    hospital_reached: RA.t('driver.act.hospital') || '🏥 Reached Hospital'
  };
  let actionsHtml = '';
  if (next) {
    actionsHtml += `<button class="btn btn-primary" onclick="advanceStatus('${next}')">${labelMap[next]} →</button>`;
  } else if (em.status === 'hospital_reached') {
    actionsHtml += `<button class="btn btn-success" disabled>${RA.t('driver.act.complete') || '✓ Case complete'}</button>`;
  }
  // Photo upload only available between 'reached' and 'picked' (i.e. after arriving at scene)
  if (em.status === 'reached' && !em.ai_completed_at) {
    actionsHtml += `
      <label class="photo-upload-btn">
        ${RA.t('driver.act.upload') || '📷 Upload Injury Photo for AI'}
        <input type="file" accept="image/*" capture="environment" onchange="uploadInjuryPhoto(event)">
      </label>`;
  }

  // Compute distance/ETA from current GPS to current target
  const target = ['picked','hospital_reached'].includes(em.status)
    ? { lat: em.hospital_lat, lng: em.hospital_lng, label: 'Hospital' }
    : { lat: em.reporter_lat, lng: em.reporter_lng, label: 'Scene' };
  const dist = (target.lat != null) ? RA.distanceKm(myLat, myLng, target.lat, target.lng) : 0;
  const eta  = RA.etaMinutes(dist);

  wrap.innerHTML = `
    <div class="active-card">
      <div class="active-header">
        <div>
          <div class="code">${RA.escapeHtml(em.request_code)}</div>
          <div class="title">${labelTitle(em.status)}</div>
        </div>
        ${RA.statusPill(em.status)}
      </div>
      <div class="active-media">${mediaHtml}</div>
      <div class="active-body">
        ${RA.workflowHtml(em.status)}
        <div class="active-grid">
          <div class="kv">
            <div class="label">${(['picked','hospital_reached'].includes(em.status) ? (RA.t('driver.t.distHospital') || 'Distance to hospital') : (RA.t('driver.t.distScene') || 'Distance to scene'))}</div>
            <div class="value">${dist.toFixed(1)} km</div>
          </div>
          <div class="kv">
            <div class="label">${RA.t('label.eta') || 'ETA'}</div>
            <div class="value" id="active-eta">${eta} min</div>
          </div>
          <div class="kv" style="grid-column: 1 / -1;">
            <div class="label">${RA.t('driver.t.hospital') || 'Hospital'}</div>
            <div class="value" style="font-size: 1rem;">${RA.escapeHtml(em.hospital_name || (RA.t('driver.t.pending') || 'Pending AI triage'))}</div>
          </div>
        </div>
        ${aiHtml}
        <div class="active-actions">${actionsHtml}</div>
      </div>
    </div>
  `;

  // Map updates
  initMap(em);
}

function labelTitle(status) {
  return ({
    accepted: RA.t('driver.st.onway') || 'On the way to scene',
    reached: RA.t('driver.st.atscene') || 'At scene',
    picked:  RA.t('driver.st.enroute') || 'En-route to hospital',
    hospital_reached: RA.t('driver.st.arrived') || 'Arrived at hospital'
  })[status] || status;
}

// Emoji map markers (Uber/Ola style)
function emojiIcon(emoji, size = 34) {
  return L.divIcon({
    className: 'emoji-marker',
    html: `<div style="font-size:${size}px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));text-align:center;">${emoji}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ── Map (shared by both Active card preview and dedicated Map tab) ──
function initMap(em) {
  if (!activeMap) {
    activeMap = L.map('map', { zoomControl: true, attributionControl: false })
      .setView([myLat, myLng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(activeMap);
  }
  // Driver/ambulance marker 🚑
  if (!driverMarker) {
    driverMarker = L.marker([myLat, myLng], { icon: emojiIcon('🚑', 36), zIndexOffset: 1000 })
      .addTo(activeMap).bindPopup('You (Ambulance)');
  } else driverMarker.setLatLng([myLat, myLng]);

  if (!em) return;

  // Victim/scene marker 🆘
  if (victimMarker) activeMap.removeLayer(victimMarker);
  victimMarker = L.marker([em.reporter_lat, em.reporter_lng], { icon: emojiIcon('🆘', 30) })
    .addTo(activeMap).bindPopup('Accident scene');

  // Hospital marker 🏥 (only after AI matched)
  if (hospitalMarker) { activeMap.removeLayer(hospitalMarker); hospitalMarker = null; }
  if (em.hospital_lat && em.hospital_lng) {
    hospitalMarker = L.marker([em.hospital_lat, em.hospital_lng], { icon: emojiIcon('🏥', 32) })
      .addTo(activeMap).bindPopup(em.hospital_name || 'Hospital');
  }

  recomputeRoute();

  // Open in Google Maps
  const dest = ['picked','hospital_reached'].includes(em.status) && em.hospital_lat
    ? `${em.hospital_lat},${em.hospital_lng}`
    : `${em.reporter_lat},${em.reporter_lng}`;
  document.getElementById('open-gmaps').href =
    `https://www.google.com/maps/dir/?api=1&origin=${myLat},${myLng}&destination=${dest}&travelmode=driving`;
}

function recomputeRoute() {
  if (!activeMap || !activeEmergency) return;
  const em = activeEmergency;
  const target = ['picked','hospital_reached'].includes(em.status) && em.hospital_lat
    ? [em.hospital_lat, em.hospital_lng]
    : [em.reporter_lat, em.reporter_lng];
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ef3e42';

  // Try a real road route via Geoapify; fall back to a straight dashed line.
  RA.Maps.getRoute(myLat, myLng, target[0], target[1]).then((route) => {
    if (routeLine) activeMap.removeLayer(routeLine);
    if (route && route.points && route.points.length > 1) {
      routeLine = L.polyline(route.points, { color: accent, weight: 5, opacity: 0.9 }).addTo(activeMap);
      try { activeMap.fitBounds(routeLine.getBounds(), { padding: [40, 40] }); } catch {}
    } else {
      // Fallback: straight dashed line
      routeLine = L.polyline([[myLat, myLng], target], {
        color: accent, weight: 4, opacity: 0.85, dashArray: '8 6'
      }).addTo(activeMap);
      try { activeMap.fitBounds([[myLat, myLng], target], { padding: [40, 40] }); } catch {}
    }
  });
}

// ── History list ───────────────────────────────────────────
function renderHistory(rows) {
  const list = document.getElementById('history-list');
  if (!rows.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-title">No history yet</div>
        <div class="empty-state-body">Cases you accept and complete will appear here for your records.</div>
      </div>`;
    return;
  }
  list.innerHTML = rows.map(e => `
    <div class="history-row">
      <div class="left">
        <div class="row-code">${RA.escapeHtml(e.request_code)}</div>
        <div class="row-title">${labelTitle(e.status)}</div>
        <div class="row-sub">${RA.escapeHtml(e.hospital_name || '—')} · ${RA.timeAgo(e.created_at)}</div>
      </div>
      ${RA.statusPill(e.status)}
    </div>
  `).join('');
}

// ── KPIs ───────────────────────────────────────────────────
function updateKpis(rows) {
  const myActive = rows.filter(e => e.assigned_driver_id === user.id && ['accepted','reached','picked'].includes(e.status)).length;
  const today = new Date(); today.setHours(0,0,0,0);
  const toDate = s => s ? new Date(s.replace(' ', 'T')) : new Date(0);
  const myDone = rows.filter(e => e.assigned_driver_id === user.id && e.status === 'hospital_reached' && toDate(e.created_at) >= today).length;
  document.getElementById('kpi-open').textContent = sosCards.size;
  document.getElementById('kpi-active').textContent = myActive;
  document.getElementById('kpi-done').textContent = myDone;
}

// ── Main refresh ───────────────────────────────────────────
async function refresh() {
  try {
    const { emergencies } = await RA.api('/api/emergency/list');
    // Active case = one assigned to me that's still IN PROGRESS (not completed).
    const myActive = emergencies.find(e =>
      e.assigned_driver_id === user.id &&
      ['accepted','reached','picked'].includes(e.status)
    );
    renderActive(myActive);

    // History = every case ever assigned to me (incl. completed ones).
    renderHistory(emergencies.filter(e => e.assigned_driver_id === user.id));
    updateKpis(emergencies);

    // ── Reconstruct pending SOS cards (so they survive a page reload) ──
    // The /list endpoint returns emergencies where I have a PENDING offer.
    // Re-add any that aren't already on screen and haven't been claimed.
    for (const e of emergencies) {
      const unclaimed = !e.assigned_driver_id && e.status === 'requested';
      if (unclaimed && !sosCards.has(e.id)) {
        const dist = (e.reporter_lat != null)
          ? RA.distanceKm(myLat, myLng, e.reporter_lat, e.reporter_lng) : 0;
        // Reconstruct with a fresh 15s window from "now" so the card is actionable.
        addSos({
          emergency: e,
          distance_km: dist,
          eta_minutes: RA.etaMinutes(dist),
          expires_at: Date.now() + 15000,
          window_ms: 15000
        });
      }
    }

    // Drop any SOS cards that have been claimed elsewhere (someone else accepted).
    for (const id of [...sosCards.keys()]) {
      const e = emergencies.find(x => x.id === id);
      if (e && e.assigned_driver_id) removeSos(id);
    }
  } catch (err) { console.warn('refresh failed', err); }
}
refresh();
setInterval(refresh, 12000);

// ── Live ETA ticker — recomputes ETA from current GPS every second ──
// Uber-style smooth countdown (e.g. 9 min 04s → 9 min 03s → ...).
setInterval(() => {
  const el = document.getElementById('active-eta');
  if (!el || !activeEmergency) return;
  const em = activeEmergency;
  const tgt = ['picked','hospital_reached'].includes(em.status) && em.hospital_lat
    ? { lat: em.hospital_lat, lng: em.hospital_lng }
    : { lat: em.reporter_lat, lng: em.reporter_lng };
  if (tgt.lat == null) return;
  const km = RA.distanceKm(myLat, myLng, tgt.lat, tgt.lng);
  const totalSec = Math.max(0, Math.round((km / 35) * 3600)); // 35 km/h urban avg
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  el.textContent = mm > 0 ? `${mm} min ${ss.toString().padStart(2,'0')}s` : `${ss}s`;
}, 1000);

// ── Globals for inline handlers ────────────────────────────
async function advanceStatus(status) {
  if (!activeEmergency) return;
  try {
    await RA.api(`/api/emergency/${activeEmergency.id}/status`, { method: 'POST', body: { status } });
    RA.toast('Status updated', RA.STATUS_LABELS[status] || status, 'success');
    refresh();
  } catch (err) { RA.toast('Error', err.message, 'warning'); }
}
window.advanceStatus = advanceStatus;

async function uploadInjuryPhoto(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file || !activeEmergency) return;
  const fd = new FormData();
  fd.append('media', file);
  RA.toast('Analyzing photo…', 'AI triage running', 'info', 3000);
  try {
    const res = await fetch(`/api/emergency/${activeEmergency.id}/photo`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RA.Auth.token },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    const ai = data.ai || {};
    const match = data.match || {};
    if (match.error) {
      RA.toast(`AI · ${ai.severity?.toUpperCase() || '—'}`, 'No suitable hospital bed available right now.', 'warning', 8000);
    } else {
      RA.toast(
        `AI · ${ai.severity?.toUpperCase() || ''}`,
        `${ai.injury_type} → ${match.bed?.label || ai.required_bed_type} @ ${match.hospital?.org_name}`,
        'success', 8000
      );
    }
    refresh();
  } catch (err) {
    RA.toast('Error', err.message, 'warning');
  }
}
window.uploadInjuryPhoto = uploadInjuryPhoto;

// ── Theme toggle (sun/moon icon swap in navbar) ────────────
function syncThemeIcon() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const isDark = theme === 'dark';
  // Navbar icons
  const navSun  = document.getElementById('navbar-theme-sun');
  const navMoon = document.getElementById('navbar-theme-moon');
  if (navSun)  navSun.style.display  = isDark ? '' : 'none';
  if (navMoon) navMoon.style.display = isDark ? 'none' : '';
}
function toggleThemeIcon() {
  RA.toggleTheme();
  syncThemeIcon();
}
window.toggleThemeIcon = toggleThemeIcon;
syncThemeIcon();

// Fill the account email hint
const emailHint = document.getElementById('settings-email');
if (emailHint) emailHint.textContent = user.email || '';
