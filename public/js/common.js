// public/js/common.js
// Shared utilities: API client, auth, toast notifications, theme, time helpers.

const API_BASE = '';

const Auth = {
  get token() { return localStorage.getItem('goldenhour_token'); },
  set token(v) { v ? localStorage.setItem('goldenhour_token', v) : localStorage.removeItem('goldenhour_token'); },
  get user() {
    try { return JSON.parse(localStorage.getItem('goldenhour_user') || 'null'); }
    catch { return null; }
  },
  set user(v) { v ? localStorage.setItem('goldenhour_user', JSON.stringify(v)) : localStorage.removeItem('goldenhour_user'); },
  logout() {
    this.token = null;
    this.user = null;
    location.href = '/';
  },
  requireRole(role) {
    const u = this.user;
    if (!u || !this.token) { location.href = '/pages/login.html'; return false; }
    if (u.role !== role) { location.href = '/'; return false; }
    return true;
  }
};

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (!(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (Auth.token) headers['Authorization'] = 'Bearer ' + Auth.token;
  const body = opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string'
    ? JSON.stringify(opts.body)
    : opts.body;
  const res = await fetch(API_BASE + path, { ...opts, headers, body });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || ('HTTP ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── Toasts ──────────────────────────────────────────────────
function toast(title, body, type = 'info', ttl = 5000) {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = `<strong>${escapeHtml(title)}</strong>${body ? `<span>${escapeHtml(body)}</span>` : ''}`;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(20px)';
    t.style.transition = 'all 0.25s';
    setTimeout(() => t.remove(), 250);
  }, ttl);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ── Theme ───────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('goldenhour_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('goldenhour_theme', next);
}
initTheme();

// ── Time helpers ────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z');
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ── Status helpers ──────────────────────────────────────────
const STATUS_LABELS = {
  requested: 'Requested',
  accepted: 'Accepted',
  reached: 'On-Scene',
  picked: 'Patient Picked',
  hospital_reached: 'Hospital Reached',
  cancelled: 'Cancelled'
};
const STATUS_ORDER = ['requested', 'accepted', 'reached', 'picked', 'hospital_reached'];

function statusPill(status) {
  return `<span class="pill pill-${status}">${STATUS_LABELS[status] || status}</span>`;
}

function workflowHtml(currentStatus) {
  const steps = ['requested', 'accepted', 'reached', 'picked', 'hospital_reached'];
  const labels = ['Requested', 'Accepted', 'Reached', 'Picked', 'At Hospital'];
  const curIdx = steps.indexOf(currentStatus);
  return `<div class="workflow">${steps.map((s, i) => {
    const cls = i < curIdx ? 'done' : i === curIdx ? 'current' : '';
    return `<div class="workflow-step ${cls}">
      <div class="workflow-dot">${i + 1}</div>
      <div class="workflow-label">${labels[i]}</div>
    </div>`;
  }).join('')}</div>`;
}

// Haversine distance
function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Estimate ETA assuming 35 km/h average urban speed
function etaMinutes(km) { return Math.max(1, Math.round((km / 35) * 60)); }

// ── Maps: Geoapify real-road routing ───────────────────────
// Fetches the public Geoapify key once from /api/config, then draws an
// actual driving route (following roads) between two points on a Leaflet map.
// Falls back to a straight dashed line if no key is configured or the API fails.
const Maps = {
  geoapifyKey: null,
  _loaded: false,
  async loadConfig() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      this.geoapifyKey = cfg.geoapifyKey || null;
    } catch { this.geoapifyKey = null; }
  },
  // Returns an array of [lat,lng] points following roads, or null on failure.
  async getRoute(fromLat, fromLng, toLat, toLng) {
    await this.loadConfig();
    if (!this.geoapifyKey) return null;
    try {
      const url = `https://api.geoapify.com/v1/routing?waypoints=${fromLat},${fromLng}|${toLat},${toLng}`
        + `&mode=drive&apiKey=${this.geoapifyKey}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const feat = data.features && data.features[0];
      if (!feat) return null;
      const geom = feat.geometry;
      // Geoapify returns MultiLineString [ [ [lng,lat], ... ], ... ]
      const coords = [];
      if (geom.type === 'MultiLineString') {
        for (const seg of geom.coordinates) for (const [lng, lat] of seg) coords.push([lat, lng]);
      } else if (geom.type === 'LineString') {
        for (const [lng, lat] of geom.coordinates) coords.push([lat, lng]);
      }
      // Distance (m) and time (s) live in properties
      const props = feat.properties || {};
      return { points: coords, distance_km: (props.distance || 0) / 1000, time_min: Math.round((props.time || 0) / 60) };
    } catch { return null; }
  }
};

// (Maps is exported as window.RA.Maps at the bottom of this file)

// Drop `data-i18n="key"` on any element and it'll auto-translate on language
// change. Use `data-i18n-html` for elements with inline <em>/<br> markup.
// Use `data-i18n-placeholder` for input placeholders.
const I18N = {
  en: {
    // Brand & nav
    'brand.name': 'Golden Hour',
    'brand.tag': 'Response System',
    'nav.login': 'Sign in',
    'nav.signup': 'Sign Up',
    'nav.simulator': '112 Simulator',
    'nav.logout': 'Logout',
    // Roles
    'role.driver': 'Driver',
    'role.hospital': 'Hospital',
    'role.bloodbank': 'Blood Bank',
    'role.dispatch': 'Dispatch',
    // Landing page
    'landing.eyebrow': 'Real-time response network — operational',
    'landing.hero.title': 'Every second <em>matters.</em><br/>So does every signal.',
    'landing.hero.sub': 'Golden Hour is a unified emergency response platform connecting 112 dispatch, ambulance drivers, hospitals, and blood banks through a single real-time coordination layer. AI-powered injury triage. Atomic bed reservation. Zero friction.',
    'landing.cta.simulator': 'Try 112 Simulator',
    'landing.cta.signin': 'Sign in to Dashboard',
    'landing.stat.window': 'Driver-acceptance window',
    'landing.stat.roles': 'roles',
    'landing.stat.rolesList': 'Driver · Hospital · Blood Bank',
    'landing.stat.triage': 'Triage from a single photo',
    'landing.stat.coord': 'Real-time socket coordination',
    'landing.network.eyebrow': 'The Network',
    'landing.network.title': 'Built for the people who <em>show up.</em>',
    'landing.network.sub': 'Three role-based dashboards. One coordinated response. Designed for the unforgiving choreography of emergency medicine.',
    'landing.driver.desc': 'Receive incoming requests with victim media and one-tap navigation. Auto-routed to nearest scene. Live status updates from acceptance through hospital arrival.',
    'landing.driver.cta': 'Driver login →',
    'landing.hospital.desc': 'Live ambulance tracking on map. ETA estimates. Patient media preview. Trigger critical blood requests instantly to the connected blood bank network.',
    'landing.hospital.cta': 'Hospital login →',
    'landing.bloodbank.desc': 'Receive instant alerts for critical blood-type requirements with originating hospital location. Respond, dispatch, and track in a single interface.',
    'landing.bloodbank.cta': 'Blood bank login →',
    'landing.flow.eyebrow': 'System Flow',
    'landing.flow.title': 'From 112 call to <em>hospital bed.</em>',
    'landing.flow.sub': '112 receives the call; location is auto-derived from the network. The nearest 5 ambulances get a 15-second SOS alert. On arrival, the driver photographs the injury — AI returns severity, blood needs, and the right hospital bed type. A bed gets reserved atomically before the ambulance even moves.',
    'landing.flow.cta': 'Try the simulator',
    'landing.flow.step1.t': '112 receives the call',
    'landing.flow.step1.d': 'Location auto-derived from the network.',
    'landing.flow.step2.t': '15-second SOS to top 5 drivers',
    'landing.flow.step2.d': 'First accept wins. Auto-assigns nearest on timeout.',
    'landing.flow.step3.t': 'Driver photographs injury at scene',
    'landing.flow.step3.d': 'AI determines severity, bed type, blood need.',
    'landing.flow.step4.t': 'Bed reserved · Blood dispatched',
    'landing.flow.step4.d': 'Hospital and blood bank notified with full case context.',
    'landing.footer.demo': 'Demo system — not for actual emergencies. Call your local emergency number.',
    // Auth common
    'auth.live': 'LIVE NETWORK',
    'auth.hero.title': 'When every <em>second</em> counts, every signal <em>matters.</em>',
    'auth.hero.sub': 'Sign in to your role-specific dashboard. Connected drivers, hospitals, and blood banks coordinate in real-time through a single response layer.',
    'auth.meta.roles': 'Roles',
    'auth.meta.dispatch': 'Dispatch',
    'auth.meta.network': 'Network',
    'auth.welcome': 'Welcome back',
    'auth.signin.title': 'Sign in to <em style="font-family:var(--font-display);font-style:italic;color:var(--accent)">Golden Hour</em>',
    'auth.signin.sub': 'Access your operational dashboard.',
    'auth.demo.title': 'Demo Credentials (click to autofill)',
    'auth.noAccount': 'No account?',
    'auth.register': 'Register here',
    'auth.haveAccount': 'Have an account?',
    'auth.signup.eyebrow': 'JOIN THE NETWORK',
    'auth.signup.title': 'Register as a <em>responder.</em>',
    'auth.signup.sub': 'Drivers, hospitals, and blood banks — register to receive real-time emergency requests routed by location and need.',
    'auth.signup.create': 'Create account',
    'auth.signup.h2': 'Register with <em style="font-family:var(--font-display);font-style:italic;color:var(--accent)">Golden Hour</em>',
    'auth.signup.choose': 'Choose your role to begin receiving real-time emergency dispatches.',
    'auth.meta.free': 'Free',
    'auth.meta.toRegister': 'To register',
    'auth.meta.2min': '2 min',
    'auth.meta.setup': 'Setup',
    'auth.meta.live': 'Live',
    'auth.meta.immediately': 'Immediately',
    'auth.created': 'Account created — opening your dashboard…',
    'auth.loginFailed': 'Login failed',
    'auth.registrationFailed': 'Registration failed',
    'auth.incompleteResponse': 'Server returned an incomplete response. Try again.',
    // Common buttons
    'btn.save': 'Save',
    'btn.cancel': 'Cancel',
    'btn.accept': 'Accept',
    'btn.reject': 'Reject',
    'btn.submit': 'Submit',
    'btn.back': '← Back',
    'btn.refresh': 'Refresh',
    'btn.confirm': 'Confirm',
    'btn.signin': 'Sign In',
    'btn.signingIn': 'Signing in...',
    'btn.signout': 'Sign out',
    'btn.createAccount': 'Create Account',
    'btn.creatingAccount': 'Creating account...',
    // Status pills
    'status.requested': 'REQUESTED',
    'status.accepted': 'Accepted',
    'status.reached': 'On-Scene',
    'status.picked': 'Patient Picked',
    'status.hospital_reached': 'Hospital Reached',
    'status.cancelled': 'Cancelled',
    // Common labels
    'label.email': 'Email Address',
    'label.password': 'Password',
    'label.passwordMin': 'Password (min 6 chars)',
    'label.name': 'Full Name',
    'label.contactName': 'Contact Person Name',
    'label.hospitalName': 'Hospital Name',
    'label.bloodbankName': 'Blood Bank Name',
    'label.phone': 'Phone',
    'label.role': 'Role',
    'label.address': 'Address',
    'label.organization': 'Organisation Name',
    'label.vehicle': 'Vehicle Number',
    'label.license': 'License Number',
    'label.severity': 'Severity',
    'label.distance': 'Distance',
    'label.eta': 'ETA',
    'label.bedType': 'Bed Type',
    'label.bloodGroup': 'Blood Group',
    'label.units': 'Units',
    // Dispatch page
    'dispatch.eyebrow': 'CONTROL ROOM',
    'dispatch.eyebrow2': 'DISPATCH · 112 SIMULATOR',
    'dispatch.title': 'Simulate an <em style="font-style:italic;color:var(--accent)">incoming</em> 112 call.',
    'dispatch.sub': 'In production this app receives location data automatically from the 112 phone network. For demo purposes, click below to spawn a random emergency anywhere in Pune.',
    'dispatch.simulate': '⚠&nbsp; Simulate <em>112 Call</em>',
    'dispatch.recent': 'Recent <em>dispatches</em>',
    'dispatch.empty': 'No calls dispatched yet. Click the red button to simulate one.',
    'dispatch.dispatching': '⏳ Dispatching…',
    'dispatch.failed': 'Dispatch failed',
    'dispatch.noDrivers': 'No drivers available',
    'dispatch.noDriversBody': 'No ambulance is currently on duty.',
    'dispatch.ambulance': 'ambulance',
    'dispatch.ambulances': 'ambulances',
    'dispatch.broadcastTo': 'Broadcast to',
    'dispatch.dispatched': 'dispatched',
    'dispatch.window': 'window',
    // Driver page
    'driver.onduty': 'ON DUTY',
    'driver.offduty': 'OFF DUTY',
    'driver.tab.sos': 'SOS',
    'driver.tab.active': 'Active',
    'driver.tab.map': 'Map',
    'driver.tab.history': 'History',
    'driver.tab.settings': 'Settings',
    'driver.sos.title': 'Live <em>SOS</em>',
    'driver.sos.sub': "Standing by. New emergencies will pop up here with a 15-second decision window.",
    'driver.kpi.open': 'Open',
    'driver.kpi.myActive': 'My active',
    'driver.kpi.doneToday': 'Done today',
    'driver.active.title': 'Active <em>case</em>',
    'driver.active.sub': "You don't have an active case right now.",
    'driver.map.title': 'Live <em>map</em>',
    'driver.map.sub': 'Your live position, the scene, and the assigned hospital.',
    'driver.openGMaps': 'Open in Google Maps ↗',
    'driver.history.title': 'My <em>history</em>',
    'driver.history.sub': 'Past 50 cases assigned to you.',
    'driver.settings.title': 'Settings',
    'driver.settings.sub': 'Account.',
    'driver.settings.account': 'Account',
    'driver.footer': 'Golden Hour · Driver Console',
    'driver.banner': 'SOS · Accident detected · 112',
    'driver.st.onway': 'On the way to scene',
    'driver.st.atscene': 'At scene',
    'driver.st.enroute': 'En-route to hospital',
    'driver.st.arrived': 'Arrived at hospital',
    'driver.act.reached': '🚑 Mark Reached',
    'driver.act.picked': '🩹 Patient Picked Up',
    'driver.act.hospital': '🏥 Reached Hospital',
    'driver.act.complete': '✓ Case complete',
    'driver.act.upload': '📷 Upload Injury Photo for AI',
    'driver.t.distScene': 'Distance to scene',
    'driver.t.distHospital': 'Distance to hospital',
    'driver.t.hospital': 'Hospital',
    'driver.t.pending': 'Pending AI triage',
    'driver.toast.accepted': "You're on your way",
    'driver.toast.sosIncoming': 'SOS Incoming',
    // Hospital page
    'hospital.console': 'Hospital Console',
    'hospital.ops': 'Operations',
    'hospital.liveMap': 'Live Map',
    'hospital.beds': 'Beds',
    'hospital.incoming': 'Incoming',
    'hospital.bloodReq': 'Blood Requests',
    'hospital.liveOps': 'LIVE OPERATIONS',
    'hospital.title': 'Emergency <em>Inbound.</em>',
    'hospital.kpi.active': 'Active',
    'hospital.kpi.inbound': 'Inbound (En-route)',
    'hospital.kpi.arrived': 'Arrived Today',
    'hospital.kpi.critical': 'Critical Pending',
    'hospital.capacity': 'Capacity',
    'hospital.bedInv': 'Bed <em>inventory</em>',
    'hospital.tracking': 'Live ambulance tracking',
    'hospital.theater': 'Operational <em>theater</em>',
    'hospital.incomingEm': 'Incoming <em>emergencies</em>',
    'hospital.bloodReqs': 'Blood <em>requests</em>',
    'hospital.newReq': '+ New Request',
    // Blood bank page
    'bb.liveAlerts': 'Live Alerts',
    'bb.status': 'Status',
    'bb.online': 'Realtime online',
    'bb.standingBy': 'STANDING BY',
    'bb.title': 'Blood <em>Operations.</em>',
    'bb.kpi.pending': 'Pending',
    'bb.kpi.accepted': 'Accepted Today',
    'bb.kpi.fulfilled': 'Fulfilled',
    'bb.kpi.total': 'Total Today',
    'bb.incomingAlerts': 'Incoming <em>blood alerts</em>',
    'bb.standby': 'Standby',
    'bb.allGroups': 'All groups (victim group unknown)',
    'bb.bloodTBD': 'Blood group: TBD',
    'bb.dispatch': 'Dispatch 🚚',
    'bb.delivered': 'Mark Delivered',
    'bb.badge.pending': 'PENDING',
    'bb.badge.accepted': 'ACCEPTED',
    'bb.badge.dispatched': 'EN-ROUTE',
    'bb.badge.fulfilled': 'DELIVERED',
    'bb.badge.rejected': 'REJECTED',
    // Misc
    'common.loading': 'Loading…',
    'common.noData': 'No data',
    'common.online': 'Online',
    'common.offline': 'Offline',
    'common.live': 'LIVE',
    'common.error': 'Error',
  },
  hi: {
    'brand.name': 'गोल्डन ऑवर',
    'brand.tag': 'रिस्पॉन्स सिस्टम',
    'nav.login': 'लॉग इन',
    'nav.signup': 'साइन अप',
    'nav.simulator': '112 सिमुलेटर',
    'nav.logout': 'लॉग आउट',
    'role.driver': 'चालक',
    'role.hospital': 'अस्पताल',
    'role.bloodbank': 'रक्त बैंक',
    'role.dispatch': 'डिस्पैच',
    'landing.eyebrow': 'रियल-टाइम रेस्पॉन्स नेटवर्क — संचालन में',
    'landing.hero.title': 'हर सेकंड <em>मायने रखता है।</em><br/>हर सिग्नल भी।',
    'landing.hero.sub': 'गोल्डन ऑवर एक एकीकृत आपातकालीन प्रतिक्रिया प्लेटफ़ॉर्म है जो 112 डिस्पैच, एम्बुलेंस चालकों, अस्पतालों और रक्त बैंकों को एक रियल-टाइम समन्वय परत के माध्यम से जोड़ता है। AI-संचालित चोट triage। परमाणु बेड आरक्षण। शून्य घर्षण।',
    'landing.cta.simulator': '112 सिमुलेटर आज़माएँ',
    'landing.cta.signin': 'डैशबोर्ड में साइन इन करें',
    'landing.stat.window': 'चालक स्वीकृति विंडो',
    'landing.stat.roles': 'भूमिकाएँ',
    'landing.stat.rolesList': 'चालक · अस्पताल · रक्त बैंक',
    'landing.stat.triage': 'एक तस्वीर से ट्रायाज',
    'landing.stat.coord': 'रियल-टाइम सॉकेट समन्वय',
    'landing.network.eyebrow': 'नेटवर्क',
    'landing.network.title': 'उन लोगों के लिए जो <em>आगे आते हैं।</em>',
    'landing.network.sub': 'तीन भूमिका-आधारित डैशबोर्ड। एक समन्वित प्रतिक्रिया। आपातकालीन चिकित्सा की कठोर कोरियोग्राफी के लिए डिज़ाइन किया गया।',
    'landing.driver.desc': 'पीड़ित मीडिया और एक-टैप नेविगेशन के साथ आने वाले अनुरोध प्राप्त करें। निकटतम दृश्य पर ऑटो-रूट किया गया। स्वीकृति से अस्पताल आगमन तक लाइव स्थिति अपडेट।',
    'landing.driver.cta': 'चालक लॉगिन →',
    'landing.hospital.desc': 'मानचित्र पर लाइव एम्बुलेंस ट्रैकिंग। ETA अनुमान। रोगी मीडिया पूर्वावलोकन। जुड़े रक्त बैंक नेटवर्क को तुरंत गंभीर रक्त अनुरोध भेजें।',
    'landing.hospital.cta': 'अस्पताल लॉगिन →',
    'landing.bloodbank.desc': 'मूल अस्पताल स्थान के साथ गंभीर रक्त-प्रकार आवश्यकताओं के लिए तत्काल अलर्ट प्राप्त करें। एक ही इंटरफ़ेस में प्रतिक्रिया दें, भेजें और ट्रैक करें।',
    'landing.bloodbank.cta': 'रक्त बैंक लॉगिन →',
    'landing.flow.eyebrow': 'सिस्टम फ्लो',
    'landing.flow.title': '112 कॉल से <em>अस्पताल बेड तक।</em>',
    'landing.flow.sub': '112 कॉल प्राप्त करता है; नेटवर्क से स्थान स्वतः प्राप्त होता है। निकटतम 5 एम्बुलेंस को 15-सेकंड का SOS अलर्ट मिलता है। आगमन पर, चालक चोट की तस्वीर लेता है — AI गंभीरता, रक्त आवश्यकताएँ और सही अस्पताल बेड प्रकार बताता है। एम्बुलेंस के चलने से पहले ही बेड परमाणु रूप से आरक्षित हो जाता है।',
    'landing.flow.cta': 'सिमुलेटर आज़माएँ',
    'landing.flow.step1.t': '112 कॉल प्राप्त करता है',
    'landing.flow.step1.d': 'नेटवर्क से स्थान स्वतः प्राप्त।',
    'landing.flow.step2.t': 'शीर्ष 5 चालकों को 15-सेकंड SOS',
    'landing.flow.step2.d': 'पहले स्वीकार जीतता है। टाइमआउट पर निकटतम स्वतः नियुक्त।',
    'landing.flow.step3.t': 'चालक दृश्य पर चोट की तस्वीर लेता है',
    'landing.flow.step3.d': 'AI गंभीरता, बेड प्रकार, रक्त आवश्यकता निर्धारित करता है।',
    'landing.flow.step4.t': 'बेड आरक्षित · रक्त भेजा गया',
    'landing.flow.step4.d': 'अस्पताल और रक्त बैंक को पूर्ण केस संदर्भ के साथ सूचित किया गया।',
    'landing.footer.demo': 'डेमो सिस्टम — वास्तविक आपात स्थिति के लिए नहीं। अपने स्थानीय आपातकालीन नंबर पर कॉल करें।',
    'auth.live': 'लाइव नेटवर्क',
    'auth.hero.title': 'जब हर <em>सेकंड</em> मायने रखता है, हर सिग्नल भी <em>मायने रखता है।</em>',
    'auth.hero.sub': 'अपने भूमिका-विशिष्ट डैशबोर्ड में साइन इन करें। जुड़े चालक, अस्पताल और रक्त बैंक एक प्रतिक्रिया परत के माध्यम से रियल-टाइम में समन्वय करते हैं।',
    'auth.meta.roles': 'भूमिकाएँ',
    'auth.meta.dispatch': 'डिस्पैच',
    'auth.meta.network': 'नेटवर्क',
    'auth.welcome': 'वापसी पर स्वागत है',
    'auth.signin.title': '<em style="font-family:var(--font-display);font-style:italic;color:var(--accent)">गोल्डन ऑवर</em> में साइन इन करें',
    'auth.signin.sub': 'अपने ऑपरेशनल डैशबोर्ड तक पहुँचें।',
    'auth.demo.title': 'डेमो क्रेडेंशियल्स (ऑटोफिल के लिए क्लिक करें)',
    'auth.noAccount': 'खाता नहीं है?',
    'auth.register': 'यहाँ पंजीकरण करें',
    'auth.haveAccount': 'खाता है?',
    'auth.signup.eyebrow': 'नेटवर्क से जुड़ें',
    'auth.signup.title': 'एक <em>उत्तरदाता</em> के रूप में पंजीकरण करें।',
    'auth.signup.sub': 'चालक, अस्पताल और रक्त बैंक — स्थान और आवश्यकता के अनुसार रियल-टाइम आपातकालीन अनुरोध प्राप्त करने के लिए पंजीकरण करें।',
    'auth.signup.create': 'खाता बनाएँ',
    'auth.signup.h2': '<em style="font-family:var(--font-display);font-style:italic;color:var(--accent)">गोल्डन ऑवर</em> के साथ पंजीकरण करें',
    'auth.signup.choose': 'रियल-टाइम आपातकालीन डिस्पैच प्राप्त करना शुरू करने के लिए अपनी भूमिका चुनें।',
    'auth.meta.free': 'मुफ़्त',
    'auth.meta.toRegister': 'पंजीकरण हेतु',
    'auth.meta.2min': '2 मिनट',
    'auth.meta.setup': 'सेटअप',
    'auth.meta.live': 'लाइव',
    'auth.meta.immediately': 'तुरंत',
    'auth.created': 'खाता बनाया गया — आपका डैशबोर्ड खोला जा रहा है…',
    'auth.loginFailed': 'लॉगिन विफल',
    'auth.registrationFailed': 'पंजीकरण विफल',
    'auth.incompleteResponse': 'सर्वर से अधूरा उत्तर मिला। फिर से प्रयास करें।',
    'btn.save': 'सहेजें',
    'btn.cancel': 'रद्द करें',
    'btn.accept': 'स्वीकार करें',
    'btn.reject': 'अस्वीकार',
    'btn.submit': 'जमा करें',
    'btn.back': '← वापस',
    'btn.refresh': 'रीफ़्रेश',
    'btn.confirm': 'पुष्टि करें',
    'btn.signin': 'साइन इन',
    'btn.signingIn': 'साइन इन हो रहा है...',
    'btn.signout': 'साइन आउट',
    'btn.createAccount': 'खाता बनाएँ',
    'btn.creatingAccount': 'खाता बनाया जा रहा है...',
    'status.requested': 'अनुरोधित',
    'status.accepted': 'स्वीकृत',
    'status.reached': 'घटनास्थल पर',
    'status.picked': 'रोगी ले लिया',
    'status.hospital_reached': 'अस्पताल पहुँचे',
    'status.cancelled': 'रद्द',
    'label.email': 'ईमेल पता',
    'label.password': 'पासवर्ड',
    'label.passwordMin': 'पासवर्ड (कम से कम 6 अक्षर)',
    'label.name': 'पूरा नाम',
    'label.contactName': 'संपर्क व्यक्ति का नाम',
    'label.hospitalName': 'अस्पताल का नाम',
    'label.bloodbankName': 'रक्त बैंक का नाम',
    'label.phone': 'फ़ोन',
    'label.role': 'भूमिका',
    'label.address': 'पता',
    'label.organization': 'संगठन का नाम',
    'label.vehicle': 'वाहन संख्या',
    'label.license': 'लाइसेंस नंबर',
    'label.severity': 'गंभीरता',
    'label.distance': 'दूरी',
    'label.eta': 'ईटीए',
    'label.bedType': 'बिस्तर प्रकार',
    'label.bloodGroup': 'रक्त समूह',
    'label.units': 'इकाइयाँ',
    'dispatch.eyebrow': 'कंट्रोल रूम',
    'dispatch.eyebrow2': 'डिस्पैच · 112 सिमुलेटर',
    'dispatch.title': 'एक <em style="font-style:italic;color:var(--accent)">आने वाली</em> 112 कॉल का सिमुलेशन करें।',
    'dispatch.sub': 'उत्पादन में यह ऐप 112 फ़ोन नेटवर्क से स्थान डेटा स्वचालित रूप से प्राप्त करता है। डेमो उद्देश्यों के लिए, पुणे में कहीं भी एक यादृच्छिक आपातकालीन उत्पन्न करने के लिए नीचे क्लिक करें।',
    'dispatch.simulate': '⚠&nbsp; <em>112 कॉल</em> सिमुलेट करें',
    'dispatch.recent': 'हाल के <em>डिस्पैच</em>',
    'dispatch.empty': 'अभी तक कोई कॉल नहीं भेजी गई। एक सिमुलेट करने के लिए लाल बटन पर क्लिक करें।',
    'dispatch.dispatching': '⏳ भेजा जा रहा है…',
    'dispatch.failed': 'डिस्पैच विफल',
    'dispatch.noDrivers': 'कोई चालक उपलब्ध नहीं',
    'dispatch.noDriversBody': 'अभी कोई एम्बुलेंस ड्यूटी पर नहीं है।',
    'dispatch.ambulance': 'एम्बुलेंस',
    'dispatch.ambulances': 'एम्बुलेंस',
    'dispatch.broadcastTo': 'को प्रसारित किया',
    'dispatch.dispatched': 'भेजा गया',
    'dispatch.window': 'विंडो',
    'driver.onduty': 'ड्यूटी पर',
    'driver.offduty': 'ड्यूटी से बाहर',
    'driver.tab.sos': 'एसओएस',
    'driver.tab.active': 'सक्रिय',
    'driver.tab.map': 'मानचित्र',
    'driver.tab.history': 'इतिहास',
    'driver.tab.settings': 'सेटिंग्स',
    'driver.sos.title': 'लाइव <em>एसओएस</em>',
    'driver.sos.sub': 'तैयार। नई आपात स्थितियाँ यहाँ 15-सेकंड के निर्णय विंडो के साथ दिखाई देंगी।',
    'driver.kpi.open': 'खुले',
    'driver.kpi.myActive': 'मेरे सक्रिय',
    'driver.kpi.doneToday': 'आज पूर्ण',
    'driver.active.title': 'सक्रिय <em>केस</em>',
    'driver.active.sub': 'अभी आपका कोई सक्रिय केस नहीं है।',
    'driver.map.title': 'लाइव <em>मानचित्र</em>',
    'driver.map.sub': 'आपकी लाइव स्थिति, दृश्य और नियुक्त अस्पताल।',
    'driver.openGMaps': 'Google Maps में खोलें ↗',
    'driver.history.title': 'मेरा <em>इतिहास</em>',
    'driver.history.sub': 'आपको सौंपे गए पिछले 50 केस।',
    'driver.settings.title': 'सेटिंग्स',
    'driver.settings.sub': 'खाता।',
    'driver.settings.account': 'खाता',
    'driver.footer': 'गोल्डन ऑवर · चालक कंसोल',
    'driver.banner': 'एसओएस · दुर्घटना का पता चला · 112',
    'driver.st.onway': 'घटनास्थल की ओर',
    'driver.st.atscene': 'घटनास्थल पर',
    'driver.st.enroute': 'अस्पताल के रास्ते में',
    'driver.st.arrived': 'अस्पताल पहुँचे',
    'driver.act.reached': '🚑 पहुँच गए',
    'driver.act.picked': '🩹 रोगी उठाया',
    'driver.act.hospital': '🏥 अस्पताल पहुँचे',
    'driver.act.complete': '✓ केस पूर्ण',
    'driver.act.upload': '📷 AI के लिए चोट की फ़ोटो अपलोड करें',
    'driver.t.distScene': 'घटनास्थल तक दूरी',
    'driver.t.distHospital': 'अस्पताल तक दूरी',
    'driver.t.hospital': 'अस्पताल',
    'driver.t.pending': 'AI ट्रायाज प्रतीक्षित',
    'driver.toast.accepted': 'आप रास्ते में हैं',
    'driver.toast.sosIncoming': 'एसओएस आ रहा है',
    'hospital.console': 'अस्पताल कंसोल',
    'hospital.ops': 'संचालन',
    'hospital.liveMap': 'लाइव मानचित्र',
    'hospital.beds': 'बिस्तर',
    'hospital.incoming': 'आने वाले',
    'hospital.bloodReq': 'रक्त अनुरोध',
    'hospital.liveOps': 'लाइव संचालन',
    'hospital.title': 'आपातकालीन <em>आगमन।</em>',
    'hospital.kpi.active': 'सक्रिय',
    'hospital.kpi.inbound': 'आने वाले (रास्ते में)',
    'hospital.kpi.arrived': 'आज आए',
    'hospital.kpi.critical': 'गंभीर लंबित',
    'hospital.capacity': 'क्षमता',
    'hospital.bedInv': 'बिस्तर <em>सूची</em>',
    'hospital.tracking': 'लाइव एम्बुलेंस ट्रैकिंग',
    'hospital.theater': 'संचालन <em>थिएटर</em>',
    'hospital.incomingEm': 'आने वाली <em>आपात स्थितियाँ</em>',
    'hospital.bloodReqs': 'रक्त <em>अनुरोध</em>',
    'hospital.newReq': '+ नया अनुरोध',
    'bb.liveAlerts': 'लाइव अलर्ट',
    'bb.status': 'स्थिति',
    'bb.online': 'रियलटाइम ऑनलाइन',
    'bb.standingBy': 'तैयार',
    'bb.title': 'रक्त <em>संचालन।</em>',
    'bb.kpi.pending': 'लंबित',
    'bb.kpi.accepted': 'आज स्वीकृत',
    'bb.kpi.fulfilled': 'पूर्ण',
    'bb.kpi.total': 'आज कुल',
    'bb.incomingAlerts': 'आने वाले <em>रक्त अलर्ट</em>',
    'bb.standby': 'तैयार रहें',
    'bb.allGroups': 'सभी ग्रुप (पीड़ित का ग्रुप अज्ञात)',
    'bb.bloodTBD': 'रक्त समूह: अनिश्चित',
    'bb.dispatch': 'भेजें 🚚',
    'bb.delivered': 'वितरित मार्क करें',
    'bb.badge.pending': 'प्रतीक्षित',
    'bb.badge.accepted': 'स्वीकृत',
    'bb.badge.dispatched': 'रास्ते में',
    'bb.badge.fulfilled': 'वितरित',
    'bb.badge.rejected': 'अस्वीकृत',
    'common.loading': 'लोड हो रहा है…',
    'common.noData': 'कोई डेटा नहीं',
    'common.online': 'ऑनलाइन',
    'common.offline': 'ऑफ़लाइन',
    'common.live': 'लाइव',
    'common.error': 'त्रुटि',
  },
  mr: {
    'brand.name': 'गोल्डन अवर',
    'brand.tag': 'रिस्पॉन्स सिस्टम',
    'nav.login': 'साइन इन',
    'nav.signup': 'साइन अप',
    'nav.simulator': '112 सिमुलेटर',
    'nav.logout': 'लॉग आऊट',
    'role.driver': 'चालक',
    'role.hospital': 'रुग्णालय',
    'role.bloodbank': 'रक्तपेढी',
    'role.dispatch': 'डिस्पॅच',
    'landing.eyebrow': 'रिअल-टाइम प्रतिसाद नेटवर्क — कार्यरत',
    'landing.hero.title': 'प्रत्येक सेकंद <em>महत्त्वाचा.</em><br/>प्रत्येक सिग्नल देखील.',
    'landing.hero.sub': 'गोल्डन अवर हे एक एकीकृत आपत्कालीन प्रतिसाद प्लॅटफॉर्म आहे जे 112 डिस्पॅच, अ‍ॅम्ब्युलन्स चालक, रुग्णालये आणि रक्तपेढ्या यांना एका रिअल-टाइम समन्वय थराद्वारे जोडते. AI-चालित इजा ट्रायएज. अणुसम बेड आरक्षण. शून्य घर्षण.',
    'landing.cta.simulator': '112 सिमुलेटर वापरून पहा',
    'landing.cta.signin': 'डॅशबोर्डमध्ये साइन इन करा',
    'landing.stat.window': 'चालक स्वीकृती विंडो',
    'landing.stat.roles': 'भूमिका',
    'landing.stat.rolesList': 'चालक · रुग्णालय · रक्तपेढी',
    'landing.stat.triage': 'एका फोटोवरून ट्रायएज',
    'landing.stat.coord': 'रिअल-टाइम सॉकेट समन्वय',
    'landing.network.eyebrow': 'नेटवर्क',
    'landing.network.title': 'जे लोक <em>हजर असतात</em> त्यांच्यासाठी बनवलेले.',
    'landing.network.sub': 'तीन भूमिका-आधारित डॅशबोर्ड. एक समन्वित प्रतिसाद. आपत्कालीन वैद्यकशास्त्राच्या कठोर कोरिओग्राफीसाठी डिझाइन केलेले.',
    'landing.driver.desc': 'पीडित मीडिया आणि एक-टॅप नेव्हिगेशनसह येणाऱ्या विनंत्या प्राप्त करा. निकटतम घटनास्थळावर ऑटो-राउट. स्वीकृतीपासून रुग्णालयात आगमनापर्यंत थेट स्थिती अद्यतने.',
    'landing.driver.cta': 'चालक लॉगिन →',
    'landing.hospital.desc': 'नकाशावर थेट अ‍ॅम्ब्युलन्स ट्रॅकिंग. ETA अंदाज. रुग्ण मीडिया पूर्वावलोकन. जोडलेल्या रक्तपेढी नेटवर्कला तत्काळ गंभीर रक्त विनंत्या ट्रिगर करा.',
    'landing.hospital.cta': 'रुग्णालय लॉगिन →',
    'landing.bloodbank.desc': 'मूळ रुग्णालय स्थानासह गंभीर रक्त-गटाच्या आवश्यकतेसाठी त्वरित अलर्ट प्राप्त करा. एकाच इंटरफेसमध्ये प्रतिसाद द्या, पाठवा आणि ट्रॅक करा.',
    'landing.bloodbank.cta': 'रक्तपेढी लॉगिन →',
    'landing.flow.eyebrow': 'सिस्टम फ्लो',
    'landing.flow.title': '112 कॉलपासून <em>रुग्णालयाच्या बेडपर्यंत.</em>',
    'landing.flow.sub': '112 कॉल प्राप्त करते; नेटवर्कमधून स्थान स्वयंचलितपणे मिळते. निकटतम 5 अ‍ॅम्ब्युलन्सना 15-सेकंदाचा SOS अलर्ट मिळतो. आगमनानंतर, चालक इजेचा फोटो काढतो — AI तीव्रता, रक्ताची गरज आणि योग्य रुग्णालय बेड प्रकार सांगते. अ‍ॅम्ब्युलन्स हलण्यापूर्वीच बेड अणुसम आरक्षित होते.',
    'landing.flow.cta': 'सिमुलेटर वापरून पहा',
    'landing.flow.step1.t': '112 कॉल प्राप्त करते',
    'landing.flow.step1.d': 'नेटवर्कमधून स्थान स्वयं-व्युत्पन्न.',
    'landing.flow.step2.t': 'शीर्ष 5 चालकांना 15-सेकंद SOS',
    'landing.flow.step2.d': 'प्रथम स्वीकार जिंकतो. टाइमआउटवर निकटतम स्वयं-नियुक्त.',
    'landing.flow.step3.t': 'चालक घटनास्थळी इजेचा फोटो काढतो',
    'landing.flow.step3.d': 'AI तीव्रता, बेड प्रकार, रक्ताची गरज ठरवते.',
    'landing.flow.step4.t': 'बेड आरक्षित · रक्त पाठवले',
    'landing.flow.step4.d': 'रुग्णालय आणि रक्तपेढीला संपूर्ण केस संदर्भासह सूचित केले.',
    'landing.footer.demo': 'डेमो सिस्टम — वास्तविक आपत्कालीन परिस्थितीसाठी नाही. आपल्या स्थानिक आपत्कालीन क्रमांकावर कॉल करा.',
    'auth.live': 'लाइव्ह नेटवर्क',
    'auth.hero.title': 'जेव्हा प्रत्येक <em>सेकंद</em> महत्त्वाचा, प्रत्येक सिग्नल देखील <em>महत्त्वाचा.</em>',
    'auth.hero.sub': 'आपल्या भूमिका-विशिष्ट डॅशबोर्डमध्ये साइन इन करा. जोडलेले चालक, रुग्णालये आणि रक्तपेढ्या एका प्रतिसाद थराद्वारे रिअल-टाइममध्ये समन्वय करतात.',
    'auth.meta.roles': 'भूमिका',
    'auth.meta.dispatch': 'डिस्पॅच',
    'auth.meta.network': 'नेटवर्क',
    'auth.welcome': 'परतीवर स्वागत',
    'auth.signin.title': '<em style="font-family:var(--font-display);font-style:italic;color:var(--accent)">गोल्डन अवर</em> मध्ये साइन इन करा',
    'auth.signin.sub': 'आपल्या ऑपरेशनल डॅशबोर्डमध्ये प्रवेश करा.',
    'auth.demo.title': 'डेमो क्रेडेन्शियल्स (ऑटोफिल करण्यासाठी क्लिक करा)',
    'auth.noAccount': 'खाते नाही?',
    'auth.register': 'येथे नोंदणी करा',
    'auth.haveAccount': 'खाते आहे?',
    'auth.signup.eyebrow': 'नेटवर्कमध्ये सामील व्हा',
    'auth.signup.title': 'एक <em>प्रतिसादकर्ता</em> म्हणून नोंदणी करा.',
    'auth.signup.sub': 'चालक, रुग्णालये आणि रक्तपेढ्या — स्थान आणि गरजेनुसार रिअल-टाइम आपत्कालीन विनंत्या प्राप्त करण्यासाठी नोंदणी करा.',
    'auth.signup.create': 'खाते तयार करा',
    'auth.signup.h2': '<em style="font-family:var(--font-display);font-style:italic;color:var(--accent)">गोल्डन अवर</em> सोबत नोंदणी करा',
    'auth.signup.choose': 'रिअल-टाइम आपत्कालीन डिस्पॅच प्राप्त करण्यास सुरुवात करण्यासाठी आपली भूमिका निवडा.',
    'auth.meta.free': 'विनामूल्य',
    'auth.meta.toRegister': 'नोंदणीसाठी',
    'auth.meta.2min': '2 मिनिटे',
    'auth.meta.setup': 'सेटअप',
    'auth.meta.live': 'लाइव्ह',
    'auth.meta.immediately': 'तत्काळ',
    'auth.created': 'खाते तयार केले — आपला डॅशबोर्ड उघडत आहे…',
    'auth.loginFailed': 'लॉगिन अयशस्वी',
    'auth.registrationFailed': 'नोंदणी अयशस्वी',
    'auth.incompleteResponse': 'सर्व्हरकडून अपूर्ण प्रतिसाद मिळाला. पुन्हा प्रयत्न करा.',
    'btn.save': 'जतन करा',
    'btn.cancel': 'रद्द करा',
    'btn.accept': 'स्वीकारा',
    'btn.reject': 'नाकारा',
    'btn.submit': 'सबमिट',
    'btn.back': '← मागे',
    'btn.refresh': 'रिफ्रेश',
    'btn.confirm': 'पुष्टी करा',
    'btn.signin': 'साइन इन',
    'btn.signingIn': 'साइन इन होत आहे...',
    'btn.signout': 'साइन आऊट',
    'btn.createAccount': 'खाते तयार करा',
    'btn.creatingAccount': 'खाते तयार होत आहे...',
    'status.requested': 'विनंती केली',
    'status.accepted': 'स्वीकारले',
    'status.reached': 'घटनास्थळी',
    'status.picked': 'रुग्ण उचलला',
    'status.hospital_reached': 'रुग्णालयात पोहोचले',
    'status.cancelled': 'रद्द',
    'label.email': 'ईमेल पत्ता',
    'label.password': 'पासवर्ड',
    'label.passwordMin': 'पासवर्ड (किमान 6 अक्षरे)',
    'label.name': 'पूर्ण नाव',
    'label.contactName': 'संपर्क व्यक्तीचे नाव',
    'label.hospitalName': 'रुग्णालयाचे नाव',
    'label.bloodbankName': 'रक्तपेढीचे नाव',
    'label.phone': 'फोन',
    'label.role': 'भूमिका',
    'label.address': 'पत्ता',
    'label.organization': 'संस्थेचे नाव',
    'label.vehicle': 'वाहन क्रमांक',
    'label.license': 'परवाना क्रमांक',
    'label.severity': 'तीव्रता',
    'label.distance': 'अंतर',
    'label.eta': 'ईटीए',
    'label.bedType': 'बेडचा प्रकार',
    'label.bloodGroup': 'रक्तगट',
    'label.units': 'युनिट्स',
    'dispatch.eyebrow': 'कंट्रोल रूम',
    'dispatch.eyebrow2': 'डिस्पॅच · 112 सिमुलेटर',
    'dispatch.title': 'एका <em style="font-style:italic;color:var(--accent)">येणाऱ्या</em> 112 कॉलचे सिमुलेशन करा.',
    'dispatch.sub': 'उत्पादनात हे अ‍ॅप 112 फोन नेटवर्कमधून स्थान डेटा स्वयंचलितपणे प्राप्त करते. डेमो हेतूंसाठी, पुण्यात कुठेही यादृच्छिक आपत्कालीन निर्माण करण्यासाठी खाली क्लिक करा.',
    'dispatch.simulate': '⚠&nbsp; <em>112 कॉल</em> सिमुलेट करा',
    'dispatch.recent': 'अलीकडील <em>डिस्पॅच</em>',
    'dispatch.empty': 'अद्याप कोणतीही कॉल पाठवली नाही. एक सिमुलेट करण्यासाठी लाल बटणावर क्लिक करा.',
    'dispatch.dispatching': '⏳ पाठवत आहे…',
    'dispatch.failed': 'डिस्पॅच अयशस्वी',
    'dispatch.noDrivers': 'कोणताही चालक उपलब्ध नाही',
    'dispatch.noDriversBody': 'सध्या कोणताही अ‍ॅम्ब्युलन्स ड्युटीवर नाही.',
    'dispatch.ambulance': 'अ‍ॅम्ब्युलन्स',
    'dispatch.ambulances': 'अ‍ॅम्ब्युलन्स',
    'dispatch.broadcastTo': 'यांना प्रसारित केले',
    'dispatch.dispatched': 'पाठवले',
    'dispatch.window': 'विंडो',
    'driver.onduty': 'ड्युटीवर',
    'driver.offduty': 'ड्युटी बंद',
    'driver.tab.sos': 'एसओएस',
    'driver.tab.active': 'सक्रिय',
    'driver.tab.map': 'नकाशा',
    'driver.tab.history': 'इतिहास',
    'driver.tab.settings': 'सेटिंग्ज',
    'driver.sos.title': 'लाइव्ह <em>एसओएस</em>',
    'driver.sos.sub': 'तयार. नवीन आपत्कालीन परिस्थिती येथे 15-सेकंदाच्या निर्णय विंडोसह दिसतील.',
    'driver.kpi.open': 'खुले',
    'driver.kpi.myActive': 'माझे सक्रिय',
    'driver.kpi.doneToday': 'आज पूर्ण',
    'driver.active.title': 'सक्रिय <em>केस</em>',
    'driver.active.sub': 'सध्या आपला कोणताही सक्रिय केस नाही.',
    'driver.map.title': 'लाइव्ह <em>नकाशा</em>',
    'driver.map.sub': 'आपले थेट स्थान, दृश्य आणि नियुक्त रुग्णालय.',
    'driver.openGMaps': 'Google Maps मध्ये उघडा ↗',
    'driver.history.title': 'माझा <em>इतिहास</em>',
    'driver.history.sub': 'आपल्याला नेमून दिलेले मागील 50 केस.',
    'driver.settings.title': 'सेटिंग्ज',
    'driver.settings.sub': 'खाते.',
    'driver.settings.account': 'खाते',
    'driver.footer': 'गोल्डन अवर · चालक कन्सोल',
    'driver.banner': 'एसओएस · अपघात आढळला · 112',
    'driver.st.onway': 'घटनास्थळाकडे',
    'driver.st.atscene': 'घटनास्थळी',
    'driver.st.enroute': 'रुग्णालयाच्या मार्गावर',
    'driver.st.arrived': 'रुग्णालयात पोहोचले',
    'driver.act.reached': '🚑 पोहोचलो',
    'driver.act.picked': '🩹 रुग्ण उचलला',
    'driver.act.hospital': '🏥 रुग्णालयात पोहोचलो',
    'driver.act.complete': '✓ केस पूर्ण',
    'driver.act.upload': '📷 AI साठी इजेचा फोटो अपलोड करा',
    'driver.t.distScene': 'घटनास्थळापर्यंत अंतर',
    'driver.t.distHospital': 'रुग्णालयापर्यंत अंतर',
    'driver.t.hospital': 'रुग्णालय',
    'driver.t.pending': 'AI ट्रायएज प्रलंबित',
    'driver.toast.accepted': 'तुम्ही मार्गावर आहात',
    'driver.toast.sosIncoming': 'एसओएस येत आहे',
    'hospital.console': 'रुग्णालय कन्सोल',
    'hospital.ops': 'संचालन',
    'hospital.liveMap': 'लाइव्ह नकाशा',
    'hospital.beds': 'बेड',
    'hospital.incoming': 'येणारे',
    'hospital.bloodReq': 'रक्त विनंत्या',
    'hospital.liveOps': 'लाइव्ह संचालन',
    'hospital.title': 'आपत्कालीन <em>आगमन.</em>',
    'hospital.kpi.active': 'सक्रिय',
    'hospital.kpi.inbound': 'येणारे (मार्गावर)',
    'hospital.kpi.arrived': 'आज आले',
    'hospital.kpi.critical': 'गंभीर प्रलंबित',
    'hospital.capacity': 'क्षमता',
    'hospital.bedInv': 'बेड <em>यादी</em>',
    'hospital.tracking': 'थेट अ‍ॅम्ब्युलन्स ट्रॅकिंग',
    'hospital.theater': 'संचालन <em>थिएटर</em>',
    'hospital.incomingEm': 'येणाऱ्या <em>आपत्कालीन परिस्थिती</em>',
    'hospital.bloodReqs': 'रक्त <em>विनंत्या</em>',
    'hospital.newReq': '+ नवीन विनंती',
    'bb.liveAlerts': 'लाइव्ह अलर्ट',
    'bb.status': 'स्थिती',
    'bb.online': 'रिअलटाइम ऑनलाइन',
    'bb.standingBy': 'तयार',
    'bb.title': 'रक्त <em>संचालन.</em>',
    'bb.kpi.pending': 'प्रलंबित',
    'bb.kpi.accepted': 'आज स्वीकारले',
    'bb.kpi.fulfilled': 'पूर्ण',
    'bb.kpi.total': 'आज एकूण',
    'bb.incomingAlerts': 'येणारे <em>रक्त अलर्ट</em>',
    'bb.standby': 'तयार राहा',
    'bb.allGroups': 'सर्व गट (पीडिताचा गट अज्ञात)',
    'bb.bloodTBD': 'रक्तगट: अनिश्चित',
    'bb.dispatch': 'पाठवा 🚚',
    'bb.delivered': 'वितरित म्हणून चिन्हांकित',
    'bb.badge.pending': 'प्रलंबित',
    'bb.badge.accepted': 'स्वीकारले',
    'bb.badge.dispatched': 'मार्गावर',
    'bb.badge.fulfilled': 'वितरित',
    'bb.badge.rejected': 'नाकारले',
    'common.loading': 'लोड होत आहे…',
    'common.noData': 'डेटा नाही',
    'common.online': 'ऑनलाइन',
    'common.offline': 'ऑफलाइन',
    'common.live': 'लाइव्ह',
    'common.error': 'त्रुटी',
  },
};
const LANG_ORDER = ['en', 'hi', 'mr'];
const LANG_LABEL = { en: 'EN', hi: 'हि', mr: 'मर' };

function getLang() { return localStorage.getItem('goldenhour_lang') || 'en'; }

// Translate helper — returns translated string for key in current lang.
function t(key) {
  const lang = getLang();
  return (I18N[lang] && I18N[lang][key]) || (I18N.en && I18N.en[key]) || null;
}

function setLang(lang) {
  if (!I18N[lang]) lang = 'en';
  localStorage.setItem('goldenhour_lang', lang);
  document.documentElement.setAttribute('lang', lang);
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const val = (I18N[lang] && I18N[lang][key]) || (I18N.en && I18N.en[key]);
    if (val == null) return;
    if (el.hasAttribute('data-i18n-placeholder')) {
      el.setAttribute('placeholder', val);
    } else if (el.hasAttribute('data-i18n-html')) {
      el.innerHTML = val;
    } else {
      el.textContent = val;
    }
  });
  // Update all lang toggle buttons on the page
  document.querySelectorAll('[data-lang-toggle]').forEach(b => { b.textContent = LANG_LABEL[lang]; });
}

function cycleLang() {
  const cur = getLang();
  const next = LANG_ORDER[(LANG_ORDER.indexOf(cur) + 1) % LANG_ORDER.length];
  setLang(next);
}

// Apply on load
document.addEventListener('DOMContentLoaded', () => setLang(getLang()));

// Wire any element with data-lang-toggle as the cycler
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-lang-toggle]')) {
    e.preventDefault();
    cycleLang();
  }
});

window.RA = {
  Auth, api, toast, escapeHtml, toggleTheme,
  timeAgo, statusPill, workflowHtml, STATUS_LABELS, STATUS_ORDER,
  distanceKm, etaMinutes,
  Maps,
  // i18n
  getLang, setLang, cycleLang, I18N, t,
};
