import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDatabase } from '../backend/src/db/database.js';
import { removeExpiredBuilds, removeStaleWorkspaces } from '../backend/src/storage/cleanup.js';

const newBuild = (database, overrides = {}) =>
  database.createBuild({ ownerHash: 'owner-a', appName: 'Demo', inputType: 'html', config: { versionName: '1.0.0' }, ...overrides });

test('creates and reads a build record', () => {
  const database = createDatabase(':memory:');
  const build = newBuild(database);
  assert.match(build.id, /^[a-f0-9]{32}$/);
  assert.equal(build.state, 'queued');
  assert.deepEqual(database.getBuild(build.id).config, { versionName: '1.0.0' });
  assert.equal(database.getBuild('missing'), null);
});

test('follows the allowed state machine and rejects invalid transitions', () => {
  const database = createDatabase(':memory:');
  const build = newBuild(database);
  database.transition(build.id, 'preparing');
  database.transition(build.id, 'compiling');
  database.transition(build.id, 'validating');
  const done = database.transition(build.id, 'completed', {
    artifact: { name: 'a.apk', size: 10, sha256: 'abc' },
    expiresAt: '2030-01-01T00:00:00.000Z'
  });
  assert.equal(done.artifactSha256, 'abc');
  assert.equal(done.expiresAt, '2030-01-01T00:00:00.000Z');
  assert.throws(() => database.transition(build.id, 'failed'), (error) => error.code === 'invalid_transition');
  const other = newBuild(database);
  assert.throws(() => database.transition(other.id, 'completed'), (error) => error.code === 'invalid_transition');
  assert.throws(() => database.transition('missing', 'failed'), (error) => error.code === 'build_not_found');
});

test('statistics and listings are scoped to the owner', () => {
  const database = createDatabase(':memory:');
  const first = newBuild(database);
  const second = newBuild(database);
  newBuild(database, { ownerHash: 'owner-b' });
  database.transition(first.id, 'failed', { errorSummary: 'boom' });
  database.transition(second.id, 'preparing');
  assert.deepEqual(database.stats('owner-a'), { total: 2, succeeded: 0, failed: 1, active: 1 });
  assert.deepEqual(database.stats('owner-b'), { total: 1, succeeded: 0, failed: 0, active: 1 });
  assert.deepEqual(database.stats('nobody'), { total: 0, succeeded: 0, failed: 0, active: 0 });
  assert.equal(database.listBuilds('owner-a').length, 2);
  assert.equal(database.listBuilds('owner-a', { limit: 1 }).length, 1);
  assert.equal(database.listBuilds('owner-b').length, 1);
  assert.equal(database.getBuild(first.id).errorSummary, 'boom');
});

test('logs are sequential and replayable', () => {
  const database = createDatabase(':memory:');
  const build = newBuild(database);
  assert.equal(database.appendLog(build.id, 'first'), 1);
  assert.equal(database.appendLog(build.id, 'second'), 2);
  assert.equal(database.appendLog(build.id, 'third'), 3);
  assert.deepEqual(database.getLogs(build.id, 1).map((log) => log.line), ['second', 'third']);
  assert.equal(database.getLogs(build.id, 3).length, 0);
});

test('interrupted builds are failed on recovery', () => {
  const database = createDatabase(':memory:');
  const queued = newBuild(database);
  const compiling = newBuild(database);
  database.transition(compiling.id, 'preparing');
  database.transition(compiling.id, 'compiling');
  const finished = newBuild(database);
  database.transition(finished.id, 'cancelled');
  assert.equal(database.recoverInterrupted(), 2);
  assert.equal(database.getBuild(queued.id).state, 'failed');
  assert.equal(database.getBuild(compiling.id).state, 'failed');
  assert.equal(database.getBuild(finished.id).state, 'cancelled');
});

test('records persist across reopening the database file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'db-test-'));
  const file = path.join(directory, 'nested', 'metadata.sqlite');
  const first = createDatabase(file);
  const build = newBuild(first);
  first.close();
  const second = createDatabase(file);
  assert.equal(second.getBuild(build.id).appName, 'Demo');
  second.close();
  await fs.rm(directory, { recursive: true });
});

test('expired builds and their artifacts are removed', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-test-'));
  const database = createDatabase(':memory:');
  const expired = newBuild(database);
  database.transition(expired.id, 'preparing');
  database.transition(expired.id, 'compiling');
  database.transition(expired.id, 'validating');
  await fs.writeFile(path.join(directory, 'old.apk'), 'data');
  database.transition(expired.id, 'completed', { artifact: { name: 'old.apk', size: 4, sha256: 'x' }, expiresAt: '2020-01-01T00:00:00.000Z' });
  const fresh = newBuild(database);
  assert.equal(await removeExpiredBuilds({ database, artifactDirectory: directory, now: new Date('2026-01-01T00:00:00.000Z') }), 1);
  assert.equal(database.getBuild(expired.id), null);
  assert.notEqual(database.getBuild(fresh.id), null);
  await assert.rejects(() => fs.access(path.join(directory, 'old.apk')));
  await fs.rm(directory, { recursive: true });
});

test('stale workspaces are removed and recent ones are kept', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-test-'));
  await fs.mkdir(path.join(directory, 'old'));
  await fs.mkdir(path.join(directory, 'recent'));
  const past = new Date(Date.now() - 5 * 3600 * 1000);
  await fs.utimes(path.join(directory, 'old'), past, past);
  assert.equal(await removeStaleWorkspaces(directory, { maxAgeMs: 3600 * 1000 }), 1);
  await fs.access(path.join(directory, 'recent'));
  await assert.rejects(() => fs.access(path.join(directory, 'old')));
  assert.equal(await removeStaleWorkspaces(path.join(directory, 'missing'), { maxAgeMs: 1 }), 0);
  await fs.rm(directory, { recursive: true });
});

test('failed and cancelled builds expire too, so history cannot grow without limit', async () => {
  const database = createDatabase(':memory:', { retentionHours: 2 });
  const failed = newBuild(database);
  const cancelled = newBuild(database);
  const running = newBuild(database);
  database.transition(failed.id, 'failed', { errorSummary: 'boom' });
  database.transition(cancelled.id, 'cancelled');
  database.transition(running.id, 'preparing');
  for (const id of [failed.id, cancelled.id]) {
    const remaining = Date.parse(database.getBuild(id).expiresAt) - Date.now();
    assert.ok(remaining > 1.9 * 3600 * 1000 && remaining <= 2 * 3600 * 1000, `unexpected expiry for ${id}`);
  }
  assert.equal(database.getBuild(running.id).expiresAt, null);
  const explicit = newBuild(database);
  database.transition(explicit.id, 'preparing');
  database.transition(explicit.id, 'compiling');
  database.transition(explicit.id, 'validating');
  database.transition(explicit.id, 'completed', { artifact: { name: 'a.apk', size: 1, sha256: 'x' }, expiresAt: '2031-01-01T00:00:00.000Z' });
  assert.equal(database.getBuild(explicit.id).expiresAt, '2031-01-01T00:00:00.000Z');
  assert.equal(database.recoverInterrupted(), 1);
  assert.ok(database.getBuild(running.id).expiresAt);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'expiry-'));
  const removed = await removeExpiredBuilds({ database, artifactDirectory: directory, now: new Date(Date.now() + 3 * 3600 * 1000) });
  assert.equal(removed, 3);
  assert.equal(database.getBuild(failed.id), null);
  assert.equal(database.getBuild(cancelled.id), null);
  assert.equal(database.getBuild(running.id), null);
  assert.notEqual(database.getBuild(explicit.id), null);
  await fs.rm(directory, { recursive: true });
});
