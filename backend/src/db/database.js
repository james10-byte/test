import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.js';

export const BUILD_STATES = Object.freeze(['queued', 'preparing', 'compiling', 'validating', 'completed', 'failed', 'cancelled']);
export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
export const ACTIVE_STATES = Object.freeze(['queued', 'preparing', 'compiling', 'validating']);

const TRANSITIONS = Object.freeze({
  queued: ['preparing', 'failed', 'cancelled'],
  preparing: ['compiling', 'failed', 'cancelled'],
  compiling: ['validating', 'failed', 'cancelled'],
  validating: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  app_name TEXT NOT NULL,
  input_type TEXT NOT NULL CHECK (input_type IN ('html', 'zip', 'url')),
  config_json TEXT NOT NULL,
  state TEXT NOT NULL,
  stage TEXT,
  error_summary TEXT,
  artifact_name TEXT,
  artifact_size INTEGER,
  artifact_sha256 TEXT,
  signing_mode TEXT NOT NULL DEFAULT 'debug',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS builds_owner_created ON builds (owner_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS builds_expiry ON builds (expires_at);
CREATE TABLE IF NOT EXISTS build_logs (
  build_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  line TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (build_id, seq),
  FOREIGN KEY (build_id) REFERENCES builds (id) ON DELETE CASCADE
);
`;

const mapRow = (row) =>
  row
    ? {
        id: row.id,
        ownerHash: row.owner_hash,
        appName: row.app_name,
        inputType: row.input_type,
        config: JSON.parse(row.config_json),
        state: row.state,
        stage: row.stage,
        errorSummary: row.error_summary,
        artifactName: row.artifact_name,
        artifactSize: row.artifact_size,
        artifactSha256: row.artifact_sha256,
        signingMode: row.signing_mode,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at
      }
    : null;

export function createDatabase(file, { retentionHours = 72 } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const statements = {
    insert: db.prepare(
      'INSERT INTO builds (id, owner_hash, app_name, input_type, config_json, state, stage, signing_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    get: db.prepare('SELECT * FROM builds WHERE id = ?'),
    listByOwner: db.prepare('SELECT * FROM builds WHERE owner_hash = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'),
    stats: db.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(state = 'completed'), 0) AS succeeded, COALESCE(SUM(state = 'failed'), 0) AS failed, COALESCE(SUM(state IN ('queued', 'preparing', 'compiling', 'validating')), 0) AS active FROM builds WHERE owner_hash = ?"
    ),
    update: db.prepare(
      'UPDATE builds SET state = ?, stage = ?, error_summary = ?, artifact_name = COALESCE(?, artifact_name), artifact_size = COALESCE(?, artifact_size), artifact_sha256 = COALESCE(?, artifact_sha256), expires_at = COALESCE(?, expires_at), updated_at = ? WHERE id = ?'
    ),
    nonTerminal: db.prepare("SELECT id FROM builds WHERE state IN ('queued', 'preparing', 'compiling', 'validating')"),
    expired: db.prepare('SELECT * FROM builds WHERE expires_at IS NOT NULL AND expires_at <= ?'),
    remove: db.prepare('DELETE FROM builds WHERE id = ?'),
    maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM build_logs WHERE build_id = ?'),
    insertLog: db.prepare('INSERT INTO build_logs (build_id, seq, line, created_at) VALUES (?, ?, ?, ?)'),
    logsAfter: db.prepare('SELECT seq, line, created_at FROM build_logs WHERE build_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'),
    storageUsage: db.prepare('SELECT COALESCE(SUM(artifact_size), 0) AS bytes FROM builds WHERE owner_hash = ?')
  };

  const transaction = (operation) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    createBuild({ id = randomBytes(16).toString('hex'), ownerHash, appName, inputType, config, signingMode = 'debug' }) {
      const now = new Date().toISOString();
      statements.insert.run(id, ownerHash, appName, inputType, JSON.stringify(config), 'queued', 'queued', signingMode, now, now);
      return mapRow(statements.get.get(id));
    },
    getBuild(id) {
      return mapRow(statements.get.get(id));
    },
    listBuilds(ownerHash, { limit = 20, offset = 0 } = {}) {
      return statements.listByOwner.all(ownerHash, limit, offset).map(mapRow);
    },
    stats(ownerHash) {
      const row = statements.stats.get(ownerHash);
      return {
        total: Number(row.total),
        succeeded: Number(row.succeeded),
        failed: Number(row.failed),
        active: Number(row.active)
      };
    },
    storageUsedBytes(ownerHash) {
      return Number(statements.storageUsage.get(ownerHash).bytes);
    },
    transition(id, nextState, { stage = null, errorSummary = null, artifact = null, expiresAt = null } = {}) {
      return transaction(() => {
        const current = statements.get.get(id);
        if (!current) throw new AppError(404, 'build_not_found', 'Build not found.');
        if (!(TRANSITIONS[current.state] ?? []).includes(nextState)) {
          throw new AppError(409, 'invalid_transition', `A build in state ${current.state} cannot move to ${nextState}.`);
        }
        const retentionExpiry =
          TERMINAL_STATES.has(nextState) && !current.expires_at
            ? new Date(Date.now() + retentionHours * 3600 * 1000).toISOString()
            : null;
        statements.update.run(
          nextState,
          stage ?? nextState,
          errorSummary,
          artifact ? artifact.name : null,
          artifact ? artifact.size : null,
          artifact ? artifact.sha256 : null,
          expiresAt ?? retentionExpiry,
          new Date().toISOString(),
          id
        );
        return mapRow(statements.get.get(id));
      });
    },
    setStage(id, stage) {
      const current = statements.get.get(id);
      if (!current) throw new AppError(404, 'build_not_found', 'Build not found.');
      db.prepare('UPDATE builds SET stage = ?, updated_at = ? WHERE id = ?').run(stage, new Date().toISOString(), id);
      return mapRow(statements.get.get(id));
    },
    appendLog(id, line) {
      return transaction(() => {
        const next = Number(statements.maxSeq.get(id).value) + 1;
        statements.insertLog.run(id, next, String(line).slice(0, 2000), new Date().toISOString());
        return next;
      });
    },
    getLogs(id, afterSeq = 0, limit = 1000) {
      return statements.logsAfter
        .all(id, afterSeq, limit)
        .map((row) => ({ seq: row.seq, line: row.line, createdAt: row.created_at }));
    },
    recoverInterrupted() {
      const identifiers = statements.nonTerminal.all().map((row) => row.id);
      for (const id of identifiers) {
        this.transition(id, 'failed', { stage: 'failed', errorSummary: 'The build was interrupted by a server restart.' });
      }
      return identifiers.length;
    },
    listExpired(nowIso) {
      return statements.expired.all(nowIso).map(mapRow);
    },
    deleteBuild(id) {
      statements.remove.run(id);
    },
    close() {
      db.close();
    }
  };
}
