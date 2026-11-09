import { DatabaseSync } from 'node:sqlite';

const JSON_COLUMNS = ['items', 'reasons', 'checks'];

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      agent           TEXT NOT NULL,
      reason          TEXT NOT NULL,
      items           TEXT NOT NULL,
      vendors         TEXT NOT NULL,
      total_cents     INTEGER NOT NULL,
      decision        TEXT NOT NULL CHECK (decision IN ('approve', 'review', 'block')),
      status          TEXT NOT NULL,
      risk            INTEGER NOT NULL DEFAULT 0,
      reasons         TEXT NOT NULL DEFAULT '[]',
      checks          TEXT NOT NULL DEFAULT '[]',
      ai_summary      TEXT,
      injection_score REAL,
      decided_by      TEXT,
      order_id        TEXT,
      capture_id      TEXT,
      capture_status  TEXT,
      refund_id       TEXT,
      error           TEXT
    );

    CREATE INDEX IF NOT EXISTS purchases_created_at ON purchases (created_at);

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL,
      purchase_id TEXT,
      type        TEXT NOT NULL,
      data        TEXT
    );
  `);
  return db;
}

function now() {
  return new Date().toISOString();
}

function decodeRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const col of JSON_COLUMNS) if (out[col] != null) out[col] = JSON.parse(out[col]);
  return out;
}

function encodeFields(fields) {
  const out = { ...fields };
  for (const col of JSON_COLUMNS) if (col in out) out[col] = JSON.stringify(out[col]);
  return out;
}

export function startOfWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

export function createStore(path) {
  const db = openDatabase(path);

  return {
    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : null;
    },

    setSetting(key, value) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).run(key, JSON.stringify(value));
    },

    deleteSetting(key) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    },

    insertPurchase(purchase) {
      const row = encodeFields({ ...purchase, created_at: now(), updated_at: now() });
      const cols = Object.keys(row);
      db.prepare(
        `INSERT INTO purchases (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`,
      ).run(row);
      return this.getPurchase(purchase.id);
    },

    updatePurchase(id, fields) {
      const row = encodeFields({ ...fields, updated_at: now() });
      const sets = Object.keys(row).map((c) => `${c} = :${c}`).join(', ');
      db.prepare(`UPDATE purchases SET ${sets} WHERE id = :id`).run({ ...row, id });
      return this.getPurchase(id);
    },

    getPurchase(id) {
      return decodeRow(db.prepare('SELECT * FROM purchases WHERE id = ?').get(id));
    },

    findPurchaseByCaptureId(captureId) {
      return decodeRow(db.prepare('SELECT * FROM purchases WHERE capture_id = ?').get(captureId));
    },

    listPurchases(limit = 200) {
      return db
        .prepare('SELECT * FROM purchases ORDER BY created_at DESC LIMIT ?')
        .all(limit)
        .map(decodeRow);
    },

    spentSinceCents(since) {
      return db
        .prepare(
          "SELECT COALESCE(SUM(total_cents), 0) AS total FROM purchases WHERE status = 'paid' AND created_at >= ?",
        )
        .get(since.toISOString()).total;
    },

    totalsByStatusSince(since) {
      const rows = db
        .prepare(
          'SELECT status, COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS cents FROM purchases WHERE created_at >= ? GROUP BY status',
        )
        .all(since.toISOString());
      return Object.fromEntries(rows.map((r) => [r.status, { count: r.count, cents: r.cents }]));
    },

    recentPurchases(sinceHours = 72) {
      const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
      return db
        .prepare(
          "SELECT * FROM purchases WHERE created_at >= ? AND status IN ('paid', 'pending_owner') ORDER BY created_at DESC",
        )
        .all(since)
        .map(decodeRow);
    },

    logEvent(type, purchaseId = null, data = null) {
      db.prepare('INSERT INTO events (created_at, purchase_id, type, data) VALUES (?, ?, ?, ?)').run(
        now(),
        purchaseId,
        type,
        data && JSON.stringify(data),
      );
    },

    listEvents(purchaseId) {
      return db
        .prepare('SELECT * FROM events WHERE purchase_id = ? ORDER BY id')
        .all(purchaseId)
        .map((e) => ({ ...e, data: e.data && JSON.parse(e.data) }));
    },

    clearActivity() {
      db.exec('DELETE FROM purchases; DELETE FROM events;');
    },
  };
}
