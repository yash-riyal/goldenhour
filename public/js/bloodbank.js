// public/js/bloodbank.js
// Blood Bank operations console — alerts only, no map.
// Each alert shows the full case context: photo + AI assessment + actions.

if (!RA.Auth.requireRole('bloodbank')) throw new Error('auth');

const user = RA.Auth.user;
document.getElementById('user-name').textContent = user.name || 'Blood Bank';
document.getElementById('user-org').textContent = user.org_name || user.email || '—';
document.getElementById('avatar').textContent = (user.org_name || user.name || 'B').charAt(0).toUpperCase();

setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB');
}, 1000);

const MY_LAT = user.lat || 18.5204;
const MY_LNG = user.lng || 73.8567;

// ── Socket ─────────────────────────────────────────────────────
const socket = io({ auth: { token: RA.Auth.token } });
socket.on('connect', () => console.log('[socket] connected'));

socket.on('blood:alert', (data) => {
  const grp = data.blood_group === 'ALL' ? 'ALL GROUPS' : (data.blood_group || '');
  RA.toast(
    `URGENT · ${grp}`,
    `${data.hospital_name || 'Hospital'}${data.units_required ? ' · ' + data.units_required + ' unit(s)' : ''}`,
    'warning', 8000
  );
  playBeep();
  refreshAlerts();
});

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 260);
  } catch {}
}

// ── Alerts ─────────────────────────────────────────────────────
let currentAlerts = [];

async function refreshAlerts() {
  try {
    const { alerts } = await RA.api('/api/emergency/blood/alerts');
    currentAlerts = alerts || [];
    renderAlerts();
    updateKpis();
  } catch (err) { console.warn('alerts refresh failed', err); }
}

function updateKpis() {
  const today = new Date(); today.setHours(0,0,0,0);
  // MySQL returns DATETIME as "YYYY-MM-DD HH:MM:SS" — replace space with T for correct JS parsing.
  const toDate = s => s ? new Date(s.replace(' ', 'T')) : new Date(0);
  const todays = currentAlerts.filter(a => toDate(a.created_at) >= today);
  document.getElementById('kpi-pending').textContent = currentAlerts.filter(a => a.status === 'pending').length;
  document.getElementById('kpi-accepted').textContent = todays.filter(a => a.status === 'accepted' || a.status === 'dispatched').length;
  document.getElementById('kpi-fulfilled').textContent = todays.filter(a => a.status === 'fulfilled').length;
  document.getElementById('kpi-total').textContent = todays.length;
  document.getElementById('alert-count').textContent = `${currentAlerts.length} alert${currentAlerts.length === 1 ? '' : 's'}`;
}

function renderAlerts() {
  const list = document.getElementById('alert-list');
  if (!currentAlerts.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🩸</div>
        <div class="empty-state-title">Standing by</div>
        <div class="empty-state-body">When hospitals raise critical blood alerts, requests will appear here with the patient's photo, AI assessment, and required blood group.</div>
      </div>`;
    return;
  }

  list.innerHTML = currentAlerts.map(a => {
    const dist = (a.hospital_lat && a.hospital_lng) ? RA.distanceKm(MY_LAT, MY_LNG, a.hospital_lat, a.hospital_lng) : null;
    const eta = dist != null ? Math.max(2, Math.round((dist / 30) * 60)) : null;
    const isPending = a.status === 'pending';
    const isAccepted = a.status === 'accepted';
    const isDispatched = a.status === 'dispatched';
    const isCritical = ['severe','critical'].includes(a.ai_severity);

    // Photo
    let photoHtml = '';
    if (a.media_path) {
      photoHtml = a.media_type === 'video'
        ? `<div class="incoming-photo"><video src="${a.media_path}" controls muted></video></div>`
        : `<div class="incoming-photo"><img src="${a.media_path}" alt="Injury photo"></div>`;
    } else {
      photoHtml = `<div class="incoming-photo incoming-photo-empty">📷 No photo from scene yet</div>`;
    }

    // AI panel
    let aiHtml = '';
    if (a.ai_summary) {
      const sevColor = isCritical ? 'var(--accent)' : 'var(--info)';
      const bloodInfo = a.blood_group === 'ALL'
        ? `<span>🩸 ${RA.t('bb.allGroups') || 'All groups (group unknown)'} × ${a.units_required || 1}</span>`
        : (a.blood_group
            ? `<span>🩸 ${RA.escapeHtml(a.blood_group)} × ${a.units_required || '?'}</span>`
            : `<span>🩸 ${RA.t('bb.bloodTBD') || 'Blood group: TBD'}</span>`);
      aiHtml = `
        <div class="incoming-ai" style="border-color: color-mix(in srgb, ${sevColor} 30%, transparent); background: color-mix(in srgb, ${sevColor} 7%, var(--bg-3));">
          <div class="incoming-ai-label" style="color:${sevColor};">
            AI TRIAGE · ${(a.ai_severity || '').toUpperCase()}
          </div>
          <div class="incoming-ai-summary">${RA.escapeHtml(a.ai_summary)}</div>
          <div class="incoming-ai-meta">
            ${a.ai_injury_type ? '<span>🩹 ' + RA.escapeHtml(a.ai_injury_type) + '</span>' : ''}
            ${bloodInfo}
          </div>
        </div>`;
    } else {
      aiHtml = `<div class="incoming-ai incoming-ai-pending"><span class="dot-pulse"></span> ${RA.t('common.loading') || 'Awaiting AI triage details…'}</div>`;
    }

    // Action buttons
    let actions = '';
    if (isPending) actions = `
      <button class="btn btn-sm btn-primary" data-action="accepted" data-id="${a.id}">${RA.t('btn.accept') || 'Accept'}</button>
      <button class="btn btn-sm btn-ghost" data-action="rejected" data-id="${a.id}">${RA.t('btn.reject') || 'Reject'}</button>`;
    else if (isAccepted) actions = `
      <button class="btn btn-sm btn-primary" data-action="dispatched" data-id="${a.id}">${RA.t('bb.dispatch') || 'Dispatch 🚚'}</button>`;
    else if (isDispatched) actions = `
      <button class="btn btn-sm btn-success" data-action="fulfilled" data-id="${a.id}">${RA.t('bb.delivered') || 'Mark Delivered'}</button>`;

    return `
      <div class="incoming-card ${isCritical || isPending ? 'critical' : ''}" data-alert="${a.id}">
        <div class="incoming-head">
          <div style="display:flex; align-items:center; gap: 14px;">
            <div class="blood-badge">${a.blood_group === 'ALL' ? 'ALL' : (a.blood_group ? RA.escapeHtml(a.blood_group) : '🩸')}</div>
            <div>
              <div class="incoming-code">${RA.escapeHtml(a.request_code || '')}</div>
              <div class="incoming-driver">
                ${RA.escapeHtml(a.hospital_name || 'Hospital')}
                ${a.blood_group === 'ALL'
                  ? ' · ' + (RA.t('bb.allGroups') || 'All groups (victim group unknown)')
                  : (a.units_required > 0 ? ' · ' + a.units_required + ' unit' + (a.units_required > 1 ? 's' : '') : ' · ' + (RA.t('bb.standby') || 'Standby'))}
              </div>
            </div>
          </div>
          <div class="incoming-status">
            ${statusBadge(a.status)}
            ${isDispatched && a.eta_minutes ? `<div class="mono text-xs" style="color:var(--info); margin-top:6px;">EN-ROUTE · ETA ${a.eta_minutes} min</div>` : ''}
          </div>
        </div>
        ${photoHtml}
        ${aiHtml}
        <div class="incoming-foot" style="gap: 10px;">
          <span class="mono text-xs muted">
            ${dist != null ? dist.toFixed(1) + ' km · ~' + eta + ' min · ' : ''}${RA.timeAgo(a.created_at)}
          </span>
          <div class="flex gap-1" style="display:flex; gap: 8px;">${actions}</div>
        </div>
      </div>
    `;
  }).join('');

  // Action wiring (don't propagate to card click)
  list.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      respond(btn.dataset.id, btn.dataset.action);
    });
  });
  // Card click → detail modal
  list.querySelectorAll('[data-alert]').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.alert));
  });
}

function statusBadge(s) {
  const m = {
    pending:    { label: RA.t('bb.badge.pending')    || 'PENDING',   cls: 'pill-warning' },
    accepted:   { label: RA.t('bb.badge.accepted')   || 'ACCEPTED',  cls: 'pill-info' },
    dispatched: { label: RA.t('bb.badge.dispatched') || 'EN-ROUTE',  cls: 'pill-info' },
    fulfilled:  { label: RA.t('bb.badge.fulfilled')  || 'DELIVERED', cls: 'pill-success' },
    rejected:   { label: RA.t('bb.badge.rejected')   || 'REJECTED',  cls: 'pill-muted' }
  };
  const it = m[s] || { label: (s || 'UNKNOWN').toUpperCase(), cls: 'pill-muted' };
  return `<span class="pill ${it.cls}">${it.label}</span>`;
}

async function respond(id, status) {
  try {
    const data = await RA.api(`/api/emergency/blood/alerts/${id}/respond`, { method: 'POST', body: { status } });
    if (status === 'dispatched' && data.alert?.eta_minutes) {
      RA.toast('Dispatched', `ETA ${data.alert.eta_minutes} min to hospital`, 'success');
    } else {
      RA.toast('Updated', `Alert marked ${status}`, 'success');
    }
    refreshAlerts();
  } catch (err) { RA.toast('Error', err.message, 'warning'); }
}

// ── Detail modal (keep simple, the card already shows most) ────
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
function closeModal() { modal.classList.remove('show'); }

function openDetail(alertId) {
  const a = currentAlerts.find(x => x.id == alertId);
  if (!a) return;

  const mediaHtml = a.media_path
    ? (a.media_type === 'video'
        ? `<video src="${a.media_path}" controls class="modal-media"></video>`
        : `<img src="${a.media_path}" alt="" class="modal-media">`)
    : `<div class="modal-media modal-media-empty">📷 No photo from scene</div>`;

  const dist = (a.hospital_lat && a.hospital_lng) ? RA.distanceKm(MY_LAT, MY_LNG, a.hospital_lat, a.hospital_lng) : null;
  const eta = dist != null ? Math.max(2, Math.round((dist / 30) * 60)) : null;

  modalBody.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="em-code">${RA.escapeHtml(a.request_code || '')}</div>
        <h3 style="margin-top:4px;">${RA.escapeHtml(a.blood_group)} · ${a.units_required} unit${a.units_required > 1 ? 's' : ''}</h3>
      </div>
      <button class="btn btn-ghost btn-sm" id="close-modal">Close</button>
    </div>
    ${mediaHtml}
    ${a.ai_summary ? `
      <div style="margin-top:14px; padding:14px; background: color-mix(in srgb, var(--accent) 8%, var(--bg-3)); border-radius: var(--radius-md); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);">
        <div class="mono text-xs" style="color: var(--accent); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px;">
          AI Triage · ${(a.ai_severity || '').toUpperCase()}
        </div>
        <div style="font-size: 0.95rem;">${RA.escapeHtml(a.ai_summary)}</div>
        ${a.ai_injury_type ? `<div class="mono text-xs muted" style="margin-top: 8px;">Injury: ${a.ai_injury_type}</div>` : ''}
      </div>` : ''}
    <div class="grid-2" style="margin-top:18px;">
      <div><div class="text-xs muted mono">HOSPITAL</div><strong>${RA.escapeHtml(a.hospital_name || '—')}</strong></div>
      <div><div class="text-xs muted mono">ADDRESS</div><strong style="font-size:0.85rem;">${RA.escapeHtml(a.hospital_address || '—')}</strong></div>
      <div><div class="text-xs muted mono">DISTANCE</div><strong>${dist != null ? dist.toFixed(1) + ' km' : '—'}</strong></div>
      <div><div class="text-xs muted mono">EST. ETA</div><strong>${eta != null ? eta + ' min' : '—'}</strong></div>
      <div><div class="text-xs muted mono">STATUS</div>${statusBadge(a.status)}</div>
      <div><div class="text-xs muted mono">REQUESTED</div><strong>${RA.timeAgo(a.created_at)}</strong></div>
    </div>
  `;
  modal.classList.add('show');
  document.getElementById('close-modal').addEventListener('click', closeModal);
}

refreshAlerts();
setInterval(refreshAlerts, 10000);
