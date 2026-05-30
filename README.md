# 🚑 Golden Hour

> _Every second matters. So does every signal._

A full-stack emergency ambulance response platform that connects **112 dispatch**, **ambulance drivers**, **hospitals**, and **blood banks** through a single real-time coordination layer — with **AI-powered injury triage** and **atomic hospital bed reservation**.

---

## ✦ What it does

1. **Witness calls 112.** The dispatcher's system auto-derives location from the call's network metadata (no app for the witness).
2. **System broadcasts an SOS** to the **top 5 nearest available ambulance drivers**, with a **15-second decision window**.
3. **First driver to accept wins** the case. If no one accepts in 15 seconds, it **auto-assigns to the single nearest driver** (Uber-style fallback).
4. **Driver navigates to scene.** Live GPS tracked.
5. **At the scene, the driver photographs the injury** through their phone-style web app.
6. **AI vision analyzes the photo** (real Gemini if a free API key is set, plausible mock otherwise) and returns:
   - Severity (`minor` / `moderate` / `severe` / `critical`)
   - Injury type, required hospital capabilities, required bed type
   - Whether blood is needed, what type, how many units
7. **System atomically reserves a hospital bed** that matches the required type + capabilities. If two emergencies happen simultaneously, the bed can't be double-booked.
8. **If blood is needed**, the nearest blood bank is alerted with **full case context** (photo, AI assessment, injury type). They can accept and dispatch, returning an ETA.
9. **Hospital sees everything**: live ambulance tracking, injury photo, AI triage, reserved bed, incoming blood ETA.

---

## ✦ Quick start

```bash
# 1. Install dependencies (no native compilation needed)
npm install

# 2. Start the server
npm start

# 3. Open the app
# → http://localhost:3000
```

That's it. The server seeds demo data automatically on first run.

> **Requirements:** Node.js 18 or newer, and a **MySQL 8** (or MariaDB 10.5+) server — either locally or remotely. The server creates all tables automatically on first boot.

---

## ✦ Demo flow — try this

Open **4 browser windows** side by side:

| Window | URL | Login |
|---|---|---|
| **1. Dispatch (112)** | `http://localhost:3000/dispatch` | _no login_ |
| **2. Driver** | `http://localhost:3000` → Driver | `driver@goldenhour.com / driver123` |
| **3. Hospital** | `http://localhost:3000` → Hospital | `hospital@goldenhour.com / hospital123` |
| **4. Blood Bank** | `http://localhost:3000` → Blood Bank | `bloodbank@goldenhour.com / blood123` |

1. **Window 1**: click the big red **Simulate 112 Call** button.
2. **Window 2 (Driver)**: an SOS card pops up with a **15-second countdown**. Click **Accept**.
3. The Active tab now shows the case. Click **Mark Reached →** when you "arrive at the scene".
4. The **📷 Upload Injury Photo** button appears. Upload **any image** from your computer. _(Any photo — the AI accepts anything; if you've set a Gemini key it'll actually analyze it.)_
5. **Window 3 (Hospital)**: an incoming case appears with the AI assessment, reserved bed, and live driver location. The **bed inventory grid** at the top updates — the reserved bed shows in the "held" count.
6. **Window 4 (Blood Bank)**: if the AI flagged blood as needed, a critical alert appears with the photo + AI summary + blood group + units. Click **Accept** → **Dispatch** → it returns an ETA visible to the hospital.
7. Back on **Window 2**, continue the workflow: **Patient Picked Up →** → **Reached Hospital →**. The hospital bed flips from `reserved` to `occupied`.

---

## ✦ Real AI (optional — free, no credit card)

Out of the box, the AI uses a **smart mock** that returns plausible triage results — fine for demos and screenshots.

For real Google Gemini vision analysis:

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with any Google account → **Create API key** → copy it
3. Open `.env` and paste it: `GEMINI_API_KEY=your_key_here`
4. Restart the server (`Ctrl+C`, then `npm start`)

Gemini's free tier (`gemini-2.0-flash`) has no charges and no credit card requirement. If the key is invalid or rate-limited, the system silently falls back to the mock.

---

## ✦ Demo credentials

| Role | Email | Password |
|---|---|---|
| **Driver** (×5) | `driver@goldenhour.com` … `driver5@goldenhour.com` | `driver123` |
| **Hospital** (×4) | `hospital@goldenhour.com` … `hospital4@goldenhour.com` | `hospital123` |
| **Blood Bank** (×2) | `bloodbank@goldenhour.com`, `bloodbank2@goldenhour.com` | `blood123` |

Hospitals are seeded with **realistic bed inventories**:
- **Ruby Hall** _(tertiary)_ — all 9 bed types (43 beds total) including Trauma, Burn, Cardiac, Pediatric, Maternity
- **Jehangir Hospital** _(multispecialty)_ — 7 bed types (30 beds)
- **Sahyadri Kothrud** _(multispecialty)_ — 7 bed types (30 beds)
- **Lokmanya Hospital** _(general)_ — Core 4 only: General, ICU, Emergency, Operation Theater (18 beds)

Each hospital starts with ~30% of beds pre-occupied so capacity feels realistic.

---

## ✦ Project structure

```
goldenhour/
├── package.json                     # Dependencies
├── .env                             # Config + optional GEMINI_API_KEY
├── README.md                        # This file
├── server/
│   ├── index.js                     # Express + Socket.IO bootstrap
│   ├── db/
│   │   ├── database.js              # SQLite (node-sqlite3-wasm) + migrations
│   │   └── seed.js                  # Demo users + bed inventory + capabilities
│   ├── middleware/auth.js           # JWT auth + role gates
│   ├── services/
│   │   ├── ai.js                    # Gemini vision call + mock fallback
│   │   ├── matching.js              # Hospital + bed matching with atomic reservation
│   │   └── dispatch.js              # SOS broadcast + 15s auto-assign
│   ├── routes/
│   │   ├── auth.js                  # signup / login / me
│   │   ├── emergency.js             # SOS, accept, photo+AI, status, blood, beds
│   │   └── users.js                 # location, drivers list, availability
│   └── uploads/                     # Photo uploads (auto-created)
└── public/
    ├── index.html                   # Landing page
    ├── css/app.css                  # Full design system
    ├── js/
    │   ├── common.js                # Shared: Auth, API, toast, theme
    │   ├── driver.js                # Mobile-first driver console
    │   ├── hospital.js              # Hospital operations console
    │   └── bloodbank.js             # Blood bank dispatch console
    └── pages/
        ├── login.html
        ├── signup.html
        ├── dispatch.html            # 112 simulator (public)
        ├── driver.html              # Phone-style UI (440px column)
        ├── hospital.html            # Desktop dashboard
        └── bloodbank.html           # Desktop dashboard
```

---

## ✦ Database schema highlights

- **`users`** — drivers, hospitals, blood banks (one table, polymorphic by `role`)
- **`emergencies`** — full case lifecycle including all AI assessment columns
- **`emergency_offers`** — which drivers each SOS was broadcast to + their accept/reject status (audit trail)
- **`emergency_events`** — every state transition logged with payload (audit)
- **`hospital_beds`** — one row per physical bed, atomically lockable (`available` / `reserved` / `occupied`)
- **`hospital_capabilities`** — capability tags per hospital (e.g. `trauma_care`, `neurosurgery`, `pediatrics`)
- **`blood_alerts`** — blood requests with hospital, units, status, ETA

---

## ✦ HTTP API

### Public
- `POST /api/emergency/sos` — simulate a 112 call. Body optional `{ lat, lng, caller_phone }`. Creates emergency, broadcasts to top 5 drivers, starts 15s timer.

### Auth
- `POST /api/auth/signup` · `POST /api/auth/login` · `GET /api/auth/me`

### Emergencies
- `GET  /api/emergency/list` — role-filtered list of cases
- `GET  /api/emergency/:id` — single case detail
- `POST /api/emergency/:id/accept` — driver claims case
- `POST /api/emergency/:id/reject` — driver declines
- `POST /api/emergency/:id/status` — advance workflow (`reached`/`picked`/`hospital_reached`)
- `POST /api/emergency/:id/photo` — driver uploads injury photo → runs AI → reserves bed → emits blood alert
- `GET  /api/emergency/beds/inventory` — hospital-only, returns bed counts by type
- `POST /api/emergency/:id/blood-alert` — hospital manually escalates (rarely needed; AI handles most)
- `GET  /api/emergency/blood/alerts` — blood-bank view
- `POST /api/emergency/blood/alerts/:id/respond` — accept / dispatch / fulfill / reject

### Users
- `POST /api/users/location` · `GET /api/users/drivers` · `POST /api/users/availability`

---

## ✦ Socket.IO events

**Client → server**
- `driver:gps { lat, lng }` — driver pushes GPS every 8 seconds

**Server → client**
- `sos:new` — SOS broadcast to nearby drivers (with 15s expiry)
- `sos:auto_assigned` — sent to the chosen driver after timeout fallback
- `emergency:incoming` — sent to assigned hospital with AI assessment + bed match
- `emergency:update` — broadcast on every state change
- `driver:location` — relay of driver GPS pushes (hospital map consumes this)
- `blood:alert` — sent to all blood banks when a new alert opens
- `blood:response` — sent to the originating hospital when a blood bank responds

Rooms: `drivers`, `hospitals`, `bloodbanks`, `driver:${id}`, `hospital:${id}`, `bloodbank:${id}`.

---

## ✦ Design system

Editorial medical-tech aesthetic — refined, urgent, no cartoonish ambulance icons.

- **Type**: Fraunces (display serif, italic accents) · Manrope (sans) · JetBrains Mono (data)
- **Accent**: Signal red `#ef3e42`, reserved exclusively for live and critical states
- **Theme**: Dark by default, light toggle in any dashboard
- **Mobile**: Driver dashboard is single-column, phone-styled (440px constrained even on desktop, by design)
- **Desktop**: Hospital + Blood Bank use a sidebar + main layout for operations-center feel

---

## ✦ Tech stack

- **Backend**: Node.js · Express · Socket.IO · SQLite (`node-sqlite3-wasm`) · JWT · bcryptjs · multer
- **Frontend**: Vanilla HTML/CSS/JS · Leaflet (OpenStreetMap, no API key)
- **AI**: Google Gemini 2.0 Flash (free tier) with smart mock fallback
- **Realtime**: Socket.IO rooms per role + per-user

No external API keys required for the core demo. Optional Gemini key unlocks real injury analysis.

---

## ✦ Stopping / restarting

- **Stop**: press `Ctrl+C` in the Command Prompt window running `npm start`
- **Restart**: `npm start` again in the same folder
- **Reset all data**: delete `server/db/goldenhour.db` and restart — fresh seed will load

---

## ✦ License

MIT
