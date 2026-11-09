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
