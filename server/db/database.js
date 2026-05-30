// server/db/database.js
// MySQL-backed, but exposes the SAME synchronous-style API the rest of the
// codebase used with SQLite, so we don't touch a single route or service file.
//
// We use sync-mysql under the hood. It runs a tiny child process that the
// main thread blocks on for each query — totally fine for a portfolio demo,
// and identical in shape to the better-sqlite3-style API:
//
//   db.prepare(sql).run(...args)  -> { changes, lastInsertRowid }
//   db.prepare(sql).get(...args)  -> row | undefined
//   db.prepare(sql).all(...args)  -> rows[]
//   db.exec(sql)                  -> runs multi-statement SQL
//   db.transaction(fn)            -> returns a function that wraps fn in BEGIN/COMMIT
//
// On boot we run the schema migrations once. SQLite-specific syntax
// (AUTOINCREMENT, TEXT CHECK constraints, etc.) has been translated to the
// nearest MySQL equivalent (AUTO_INCREMENT, ENUM, DATETIME).

const SyncMysql = require('sync-mysql');

// ─── Parse connection from env ───────────────────────────────────────
// Supports either a full DATABASE_URL (Aiven / Railway / PlanetScale)
// or individual DB_HOST / DB_USER / DB_PASSWORD / DB_NAME / DB_PORT env vars.
function buildConnectionConfig() {
  const url = process.env.DATABASE_URL;
  if (url) {
    // mysql://user:pass@host:port/db?ssl-mode=REQUIRED
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.slice(1),
      ssl: parsed.searchParams.get('ssl-mode') === 'REQUIRED'
        ? { rejectUnauthorized: false }
        : undefined,
      multipleStatements: true,
    };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'goldenhour',
    multipleStatements: true,
  };
}

const config = buildConnectionConfig();
const conn = new SyncMysql(config);
console.log(`[db] connected to MySQL @ ${config.host}:${config.port}/${config.database}`);

// ─── SQLite → MySQL query translation ────────────────────────────────
// Most SQL works identically. We just rewrite a couple of SQLite-isms.
function translateSqliteToMysql(sql) {
  return sql
    .replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()')
    .replace(/\brandom\s*\(\s*\)/gi, 'RAND()')
    // SQLite: INSERT OR IGNORE  -> MySQL: INSERT IGNORE
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT IGNORE INTO')
    // SQLite: INSERT OR REPLACE -> MySQL: REPLACE INTO
    .replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'REPLACE INTO');
}

function flattenArgs(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

// ─── db object (same API the routes already use) ─────────────────────
const db = {
  exec(sql) {
    conn.query(translateSqliteToMysql(sql));
    return this;
  },

  pragma(_stmt) { /* no-op — MySQL doesn't need PRAGMAs */ },

  prepare(sql) {
    const translated = translateSqliteToMysql(sql);
    return {
      run(...args) {
        const result = conn.query(translated, flattenArgs(args));
        return {
          changes: result?.affectedRows ?? 0,
          lastInsertRowid: result?.insertId ?? 0,
        };
      },
      get(...args) {
        const rows = conn.query(translated, flattenArgs(args));
        if (!Array.isArray(rows)) return undefined;
        return rows[0];
      },
      all(...args) {
        const rows = conn.query(translated, flattenArgs(args));
        return Array.isArray(rows) ? rows : [];
      },
    };
  },

  transaction(fn) {
    return (...args) => {
      conn.query('START TRANSACTION');
      try {
        const result = fn(...args);
        conn.query('COMMIT');
        return result;
      } catch (err) {
        try { conn.query('ROLLBACK'); } catch {}
        throw err;
      }
    };
  },

  close() {
    try { conn.dispose(); } catch {}
  },
};

function safeClose() { try { db.close(); } catch {} }
process.on('SIGINT', () => { safeClose(); process.exit(0); });
process.on('SIGTERM', () => { safeClose(); process.exit(0); });
process.on('exit', safeClose);

// ─── Schema (idempotent, MySQL syntax) ───────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    role ENUM('driver','hospital','bloodbank') NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    phone VARCHAR(50),
    password_hash VARCHAR(255) NOT NULL,
    vehicle_number VARCHAR(100),
    license_number VARCHAR(100),
    org_name VARCHAR(255),
    address TEXT,
    lat DOUBLE,
    lng DOUBLE,
    is_available TINYINT(1) DEFAULT 1,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS emergencies (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    request_code VARCHAR(50) NOT NULL UNIQUE,
    reporter_lat DOUBLE NOT NULL,
    reporter_lng DOUBLE NOT NULL,
    caller_phone VARCHAR(50),
    source VARCHAR(50) DEFAULT '112',
    media_path TEXT,
    media_type VARCHAR(50),
    status ENUM('requested','accepted','reached','picked','hospital_reached','cancelled') NOT NULL DEFAULT 'requested',
    severity ENUM('normal','critical') DEFAULT 'normal',
    blood_required VARCHAR(20),
    blood_units_required INT,
    notes TEXT,
    ai_severity VARCHAR(50),
    ai_injury_type VARCHAR(100),
    ai_required_bed_type VARCHAR(50),
    ai_required_capabilities TEXT,
    ai_blood_group VARCHAR(10),
    ai_blood_units INT,
    ai_summary TEXT,
    ai_confidence DOUBLE,
    ai_completed_at DATETIME,
    assigned_driver_id INT,
    assigned_hospital_id INT,
    reserved_bed_id INT,
    auto_assigned_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    accepted_at DATETIME,
    reached_at DATETIME,
    picked_at DATETIME,
    hospital_reached_at DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS emergency_offers (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    emergency_id INT NOT NULL,
    driver_id INT NOT NULL,
    status ENUM('pending','accepted','rejected','expired') DEFAULT 'pending',
    offered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME,
    UNIQUE KEY uniq_em_driver (emergency_id, driver_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS hospital_beds (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    hospital_id INT NOT NULL,
    bed_type ENUM('general','icu','emergency','operation','trauma','burn','cardiac','pediatric','maternity') NOT NULL,
    bed_label VARCHAR(50),
    status ENUM('available','reserved','occupied') NOT NULL DEFAULT 'available',
    current_emergency_id INT,
    reserved_at DATETIME,
    occupied_at DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS hospital_capabilities (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    hospital_id INT NOT NULL,
    capability VARCHAR(100) NOT NULL,
    UNIQUE KEY uniq_hosp_cap (hospital_id, capability)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS emergency_events (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    emergency_id INT NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    actor_role VARCHAR(50),
    actor_id INT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS blood_alerts (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    emergency_id INT NOT NULL,
    hospital_id INT NOT NULL,
    blood_group VARCHAR(10) NOT NULL,
    units_required INT DEFAULT 1,
    status ENUM('pending','accepted','dispatched','fulfilled','rejected') DEFAULT 'pending',
    bloodbank_id INT,
    eta_minutes INT,
    dispatched_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);

// Indexes — MySQL has no `CREATE INDEX IF NOT EXISTS`, so we try and ignore duplicates.
const indexes = [
  ['idx_emergencies_status',   'emergencies',          'status'],
  ['idx_emergencies_driver',   'emergencies',          'assigned_driver_id'],
  ['idx_emergencies_hospital', 'emergencies',          'assigned_hospital_id'],
  ['idx_users_role',           'users',                'role'],
  ['idx_blood_alerts_status',  'blood_alerts',         'status'],
  ['idx_beds_hospital_type',   'hospital_beds',        'hospital_id, bed_type, status'],
  ['idx_beds_status',          'hospital_beds',        'status'],
  ['idx_offers_emergency',     'emergency_offers',     'emergency_id'],
  ['idx_offers_driver',        'emergency_offers',     'driver_id, status'],
  ['idx_caps_hospital',        'hospital_capabilities','hospital_id'],
];
for (const [name, table, cols] of indexes) {
  try { db.exec(`CREATE INDEX ${name} ON ${table} (${cols})`); }
  catch (err) {
    if (!/Duplicate key|exists/i.test(err.message || '')) {
      console.warn(`[db] index ${name} skipped:`, err.message);
    }
  }
}

console.log('[db] schema ready');

module.exports = db;
