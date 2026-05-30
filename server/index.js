// server/index.js
// Golden Hour main server — Express + Socket.IO + SQLite
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const db = require('./db/database');
const seed = require('./db/seed');
const authRoutes = require('./routes/auth');
const emergencyRoutes = require('./routes/emergency');
const userRoutes = require('./routes/users');
const { SECRET } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('io', io);

// ─── Middleware ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploads
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'server/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── API Routes ─────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/users', userRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Public runtime config for the frontend (e.g. Geoapify maps key).
// The Geoapify key is a client-side key meant to be restricted by domain in
// the Geoapify dashboard — safe to expose here.
app.get('/api/config', (req, res) => {
  res.json({
    geoapifyKey: process.env.GEOAPIFY_API_KEY || null,
    aiEnabled: !!process.env.GEMINI_API_KEY,
  });
});

// SPA fallback for HTML pages (so /driver, /hospital, etc. routes work if accessed directly)
app.get(['/driver', '/hospital', '/bloodbank', '/login', '/signup', '/dispatch'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pages', req.path.slice(1) + '.html'));
});

// ─── Socket.IO real-time ────────────────────────────────────────
io.on('connection', (socket) => {
  // Authenticate socket via token
  const { token } = socket.handshake.auth || {};
  if (token) {
    try {
      const user = jwt.verify(token, SECRET);
      socket.data.user = user;
      // Role-specific rooms
      socket.join(`${user.role}:${user.id}`);
      if (user.role === 'driver') socket.join('drivers');
      if (user.role === 'hospital') socket.join('hospitals');
      if (user.role === 'bloodbank') socket.join('bloodbanks');
      socket.emit('auth:ok', { user });
    } catch (e) {
      socket.emit('auth:error', { error: 'Invalid token' });
    }
  }

  // Driver pushes live GPS — broadcast to everyone tracking this driver
  socket.on('driver:gps', ({ lat, lng }) => {
    if (!socket.data.user || socket.data.user.role !== 'driver') return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    db.prepare('UPDATE users SET lat = ?, lng = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?')
      .run(lat, lng, socket.data.user.id);
    io.emit('driver:location', { driver_id: socket.data.user.id, lat, lng });
  });

  socket.on('disconnect', () => {});
});

// ─── Boot ───────────────────────────────────────────────────────
seed(); // seeds only if empty

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚑 Golden Hour running at http://localhost:${PORT}\n`);
  console.log('   Demo credentials:');
  console.log('   ─────────────────────────────────────────────');
  console.log('   Driver      driver@goldenhour.com    / driver123');
  console.log('   Hospital    hospital@goldenhour.com  / hospital123');
  console.log('   Blood Bank  bloodbank@goldenhour.com / blood123');
  console.log('   ─────────────────────────────────────────────\n');
});
