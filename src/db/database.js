import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

let currentDb = null;

export function initDatabase(dbPath = null) {
  if (!dbPath) {
    const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const defaultFile = path.join(dataDir, 'github_discord_bot.sqlite');
    const legacyFile = path.join(dataDir, 'repo_pulse.sqlite');
    dbPath = fs.existsSync(legacyFile) && !fs.existsSync(defaultFile) ? legacyFile : defaultFile;
  }

  const db = new DatabaseSync(dbPath);

  // Enable foreign keys and WAL mode if file-based
  if (dbPath !== ':memory:') {
    db.exec(`PRAGMA journal_mode = WAL;`);
  }
  db.exec(`PRAGMA foreign_keys = ON;`);

  // Initialize tables and migrations
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id INTEGER,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      is_owned INTEGER NOT NULL DEFAULT 0,
      is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private = 0),
      monitoring_type TEXT NOT NULL CHECK (monitoring_type IN ('webhook', 'polling')),
      enabled INTEGER NOT NULL DEFAULT 1,
      polling_interval_seconds INTEGER NOT NULL DEFAULT 300,
      last_polled_at TEXT,
      last_etag TEXT,
      last_event_id TEXT,
      health_status TEXT NOT NULL DEFAULT 'healthy',
      health_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repository_preferences (
      repository_id INTEGER PRIMARY KEY,
      notify_releases INTEGER NOT NULL DEFAULT 1,
      notify_pull_requests INTEGER NOT NULL DEFAULT 1,
      notify_issues INTEGER NOT NULL DEFAULT 1,
      notify_pushes INTEGER NOT NULL DEFAULT 0,
      notify_stars INTEGER NOT NULL DEFAULT 1,
      notify_forks INTEGER NOT NULL DEFAULT 1,
      notify_comments INTEGER NOT NULL DEFAULT 1,
      notify_reviews INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS processed_events (
      dedup_key TEXT PRIMARY KEY,
      repository_full_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('webhook', 'polling')),
      source_event_id TEXT,
      title TEXT,
      summary TEXT,
      url TEXT,
      actor TEXT,
      delivered_to_discord INTEGER NOT NULL DEFAULT 0,
      discord_response_status INTEGER,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_processed_events_repo 
    ON processed_events(repository_full_name, processed_at DESC);

    -- Durable Outbox Delivery Queue
    CREATE TABLE IF NOT EXISTS delivery_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key TEXT UNIQUE NOT NULL,
      repository_full_name TEXT NOT NULL,
      event_category TEXT NOT NULL,
      event_action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_queue_pending
    ON delivery_queue(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  currentDb = db;
  return db;
}

export function getDatabase() {
  if (!currentDb) {
    return initDatabase();
  }
  return currentDb;
}

export function setDatabase(db) {
  currentDb = db;
}

// -------------------------------------------------------------
// Repository Operations
// -------------------------------------------------------------

export function parseUtcTimestamp(str) {
  if (!str) return null;
  if (typeof str !== 'string') {
    const t = new Date(str).getTime();
    return isNaN(t) ? null : t;
  }
  const normalized = str.includes('T') ? (str.endsWith('Z') ? str : str + 'Z') : str.replace(' ', 'T') + 'Z';
  const time = new Date(normalized).getTime();
  return isNaN(time) ? null : time;
}

export function addRepository(repoData) {
  const db = getDatabase();

  if (repoData.is_private) {
    throw new Error('Rejected: GitHub Discord Bot cannot monitor private repositories.');
  }

  const nowIso = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO repositories (
      github_id, owner, name, full_name, is_owned, is_private, 
      monitoring_type, enabled, polling_interval_seconds, health_status, health_message,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    repoData.github_id || null,
    repoData.owner,
    repoData.name,
    repoData.full_name,
    repoData.is_owned ? 1 : 0,
    repoData.monitoring_type || (repoData.is_owned ? 'webhook' : 'polling'),
    repoData.enabled !== undefined ? (repoData.enabled ? 1 : 0) : 1,
    repoData.polling_interval_seconds || 300,
    repoData.health_status || 'healthy',
    repoData.health_message || null,
    repoData.created_at || nowIso,
    nowIso
  );

  const repoId = Number(result.lastInsertRowid);

  // Set default notification preferences
  const prefsStmt = db.prepare(`
    INSERT INTO repository_preferences (
      repository_id, notify_releases, notify_pull_requests, notify_issues, 
      notify_pushes, notify_stars, notify_forks, notify_comments, notify_reviews
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const prefs = repoData.preferences || {};
  prefsStmt.run(
    repoId,
    prefs.notify_releases !== undefined ? (prefs.notify_releases ? 1 : 0) : 1,
    prefs.notify_pull_requests !== undefined ? (prefs.notify_pull_requests ? 1 : 0) : 1,
    prefs.notify_issues !== undefined ? (prefs.notify_issues ? 1 : 0) : 1,
    prefs.notify_pushes !== undefined ? (prefs.notify_pushes ? 1 : 0) : 0,
    prefs.notify_stars !== undefined ? (prefs.notify_stars ? 1 : 0) : 1,
    prefs.notify_forks !== undefined ? (prefs.notify_forks ? 1 : 0) : 1,
    prefs.notify_comments !== undefined ? (prefs.notify_comments ? 1 : 0) : 1,
    prefs.notify_reviews !== undefined ? (prefs.notify_reviews ? 1 : 0) : 1
  );

  return getRepositoryById(repoId);
}

export function getRepositoryById(id) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT r.*, 
      p.notify_releases, p.notify_pull_requests, p.notify_issues, 
      p.notify_pushes, p.notify_stars, p.notify_forks,
      p.notify_comments, p.notify_reviews
    FROM repositories r
    LEFT JOIN repository_preferences p ON r.id = p.repository_id
    WHERE r.id = ?
  `);
  const row = stmt.get(id);
  return formatRepositoryRow(row);
}

export function getRepositoryByFullName(fullName) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT r.*, 
      p.notify_releases, p.notify_pull_requests, p.notify_issues, 
      p.notify_pushes, p.notify_stars, p.notify_forks,
      p.notify_comments, p.notify_reviews
    FROM repositories r
    LEFT JOIN repository_preferences p ON r.id = p.repository_id
    WHERE r.full_name = ?
  `);
  const row = stmt.get(fullName);
  return formatRepositoryRow(row);
}

export function getAllRepositories(filter = {}) {
  const db = getDatabase();
  let query = `
    SELECT r.*, 
      p.notify_releases, p.notify_pull_requests, p.notify_issues, 
      p.notify_pushes, p.notify_stars, p.notify_forks,
      p.notify_comments, p.notify_reviews
    FROM repositories r
    LEFT JOIN repository_preferences p ON r.id = p.repository_id
  `;
  const params = [];

  if (filter.is_owned !== undefined) {
    query += ` WHERE r.is_owned = ?`;
    params.push(filter.is_owned ? 1 : 0);
  } else if (filter.monitoring_type) {
    query += ` WHERE r.monitoring_type = ?`;
    params.push(filter.monitoring_type);
  }

  query += ` ORDER BY r.is_owned DESC, r.full_name ASC`;

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return rows.map(formatRepositoryRow);
}

export function updateRepository(id, updates) {
  const db = getDatabase();
  const fields = [];
  const params = [];

  const allowedFields = [
    'enabled', 'polling_interval_seconds', 'last_polled_at', 
    'last_etag', 'last_event_id', 'health_status', 'health_message',
    'monitoring_type'
  ];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = ?`);
      params.push(typeof updates[field] === 'boolean' ? (updates[field] ? 1 : 0) : updates[field]);
    }
  }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    params.push(id);
    const stmt = db.prepare(`UPDATE repositories SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...params);
  }

  if (updates.preferences) {
    updateRepositoryPreferences(id, updates.preferences);
  }

  return getRepositoryById(id);
}

export function updateRepositoryPreferences(repositoryId, prefs) {
  const db = getDatabase();
  const fields = [];
  const params = [];

  const allowedPrefs = [
    'notify_releases', 'notify_pull_requests', 'notify_issues',
    'notify_pushes', 'notify_stars', 'notify_forks',
    'notify_comments', 'notify_reviews'
  ];

  for (const pref of allowedPrefs) {
    if (prefs[pref] !== undefined) {
      fields.push(`${pref} = ?`);
      params.push(prefs[pref] ? 1 : 0);
    }
  }

  if (fields.length > 0) {
    params.push(repositoryId);
    const stmt = db.prepare(`
      UPDATE repository_preferences 
      SET ${fields.join(', ')} 
      WHERE repository_id = ?
    `);
    stmt.run(...params);
  }
}

export function deleteRepository(id) {
  const db = getDatabase();
  const stmt = db.prepare(`DELETE FROM repositories WHERE id = ?`);
  const result = stmt.run(id);
  return result.changes > 0;
}

// -------------------------------------------------------------
// Event Checkpointing & Deduplication
// -------------------------------------------------------------

export function isEventProcessed(dedupKey) {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT 1 FROM processed_events WHERE dedup_key = ?`);
  const row = stmt.get(dedupKey);
  return !!row;
}

export function recordProcessedEvent(event) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO processed_events (
      dedup_key, repository_full_name, event_type, source,
      source_event_id, title, summary, url, actor,
      delivered_to_discord, discord_response_status, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  stmt.run(
    event.dedupKey,
    event.repository,
    event.category || event.event_type,
    event.source,
    event.sourceEventId || null,
    event.title || null,
    event.description || event.summary || null,
    event.url || null,
    typeof event.actor === 'object' ? event.actor?.name : (event.actor || null),
    event.delivered_to_discord ? 1 : 0,
    event.discord_response_status || null
  );
}

export function getRecentProcessedEvents(limit = 50) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM processed_events 
    ORDER BY processed_at DESC 
    LIMIT ?
  `);
  return stmt.all(limit).map(row => ({
    ...row,
    delivered_to_discord: Boolean(row.delivered_to_discord)
  }));
}

// -------------------------------------------------------------
// Durable Outbox / Delivery Queue
// -------------------------------------------------------------

export function enqueueDelivery(event, maxAttempts = 5) {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO delivery_queue (
      dedup_key, repository_full_name, event_category, event_action,
      payload_json, status, attempts, max_attempts, next_attempt_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, datetime('now'))
  `);

  const result = stmt.run(
    event.dedupKey,
    event.repository,
    event.category,
    event.action,
    JSON.stringify(event),
    maxAttempts
  );

  return Number(result.lastInsertRowid);
}

export function getPendingDeliveries(batchSize = 10) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM delivery_queue
    WHERE status IN ('pending', 'failed')
      AND next_attempt_at <= datetime('now')
    ORDER BY id ASC
    LIMIT ?
  `);
  return stmt.all(batchSize).map(row => ({
    ...row,
    payload: JSON.parse(row.payload_json)
  }));
}

export function markDeliveryProcessing(id) {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE delivery_queue 
    SET status = 'processing', updated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(id);
}

export function markDeliverySuccess(id) {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE delivery_queue 
    SET status = 'delivered', updated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(id);
}

export function markDeliveryFailure(id, errorMsg, delaySeconds = 10) {
  const db = getDatabase();
  // Fetch attempts to determine if dead_letter
  const itemStmt = db.prepare(`SELECT attempts, max_attempts FROM delivery_queue WHERE id = ?`);
  const item = itemStmt.get(id);
  if (!item) return;

  const newAttempts = item.attempts + 1;
  const isDeadLetter = newAttempts >= item.max_attempts;
  const status = isDeadLetter ? 'dead_letter' : 'failed';

  const updateStmt = db.prepare(`
    UPDATE delivery_queue 
    SET attempts = ?,
        status = ?,
        last_error = ?,
        next_attempt_at = datetime('now', '+' || ? || ' seconds'),
        updated_at = datetime('now')
    WHERE id = ?
  `);

  updateStmt.run(newAttempts, status, errorMsg, delaySeconds, id);
}

export function getQueueStatus() {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT status, COUNT(*) as count 
    FROM delivery_queue 
    GROUP BY status
  `);
  const rows = stmt.all();
  const counts = { pending: 0, processing: 0, delivered: 0, failed: 0, dead_letter: 0 };
  for (const r of rows) {
    counts[r.status] = r.count;
  }
  return counts;
}

export function retryDeliveryItem(id) {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE delivery_queue 
    SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `);
  const result = stmt.run(id);
  return result.changes > 0;
}

export function retryAllDeadLetters() {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE delivery_queue 
    SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'), updated_at = datetime('now')
    WHERE status = 'dead_letter'
  `);
  const result = stmt.run();
  return result.changes;
}

// -------------------------------------------------------------
// System Settings
// -------------------------------------------------------------

export function getSetting(key, defaultValue = null) {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT value FROM system_settings WHERE key = ?`);
  const row = stmt.get(key);
  return row ? row.value : defaultValue;
}

export function setSetting(key, value) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO system_settings (key, value, updated_at) 
    VALUES (?, ?, datetime('now'))
  `);
  stmt.run(key, String(value));
}

export function getAllSettings() {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT key, value FROM system_settings`);
  const rows = stmt.all();
  const settings = {};
  for (const r of rows) {
    settings[r.key] = r.value;
  }
  return settings;
}

// Helper formatter
function formatRepositoryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    github_id: row.github_id,
    owner: row.owner,
    name: row.name,
    full_name: row.full_name,
    is_owned: Boolean(row.is_owned),
    is_private: Boolean(row.is_private),
    monitoring_type: row.monitoring_type,
    enabled: Boolean(row.enabled),
    polling_interval_seconds: row.polling_interval_seconds,
    last_polled_at: row.last_polled_at,
    last_etag: row.last_etag,
    last_event_id: row.last_event_id,
    health_status: row.health_status,
    health_message: row.health_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
    preferences: {
      notify_releases: Boolean(row.notify_releases),
      notify_pull_requests: Boolean(row.notify_pull_requests),
      notify_issues: Boolean(row.notify_issues),
      notify_pushes: Boolean(row.notify_pushes),
      notify_stars: Boolean(row.notify_stars),
      notify_forks: Boolean(row.notify_forks),
      notify_comments: Boolean(row.notify_comments),
      notify_reviews: Boolean(row.notify_reviews)
    }
  };
}
