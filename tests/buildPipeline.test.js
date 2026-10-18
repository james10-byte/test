import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createBuildRunner } from '../backend/src/build/buildRunner.js';
import { createBuildService } from '../backend/src/build/buildService.js';
import { createDatabase } from '../backend/src/db/database.js';
import { createBuildEvents } from '../backend/src/events.js';
import { BuildQueue } from '../backend/src/queue/buildQueue.js';
import {
  fakeApk,
  makeTestConfig,
  sampleHtml,
  sampleIcon,
  sampleSiteZip,
  validConfig,
  waitFor,
  writeExecutable
} from './helpers/fixtures.js';

const silentLogger = { error() {}, info() {}, warn() {} };
const noopQueue = () => ({ enqueue() {}, position: () => null, cancel: () => 'unknown' });
const publicProbe = async (url) => ({ finalUrl: url, status: 200, redirects: 0, secure: true, contentType: 'text/html' });

async function createPipeline(overrides = {}, queue = noopQueue()) {
  const { config, root } = await makeTestConfig(overrides);
  const database = createDatabase(':memory:');
  const events = createBuildEvents();
  const service = createBuildService({ config, database, queue, probe: publicProbe });
  const runner = createBuildRunner({ config, database, events, logger: silentLogger });
  return { config, root, database, events, service, runner, queue };
}

const stubGradleSuccess = async (root) => {
  const apk = path.join(root, 'prebuilt.apk');
  await fs.writeFile(apk, fakeApk());
  await writeExecutable(
    path.join(root, 'fake-gradle.sh'),
    `echo "> Task :app:assembleDebug in $PWD"\nmkdir -p app/build/outputs/apk/debug\ncp ${apk} app/build/outputs/apk/debug/app-debug.apk\necho BUILD SUCCESSFUL`
  );
};

const owner = 'a'.repeat(64);

test('submitting an html build stores the workspace, icon and queued record', async () => {
  const { service, database, config } = await createPipeline();
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: await sampleIcon() });
  assert.equal(build.state, 'queued');
  assert.equal(build.appName, 'Demo App');
  assert.equal(build.config.site.entryFile, 'index.html');
  assert.equal(build.config.iconInfo.usingDefault, false);
  assert.ok(build.config.warnings.some((warning) => warning.code === 'missing_local_resources'));
  await fs.access(path.join(config.workspaceDirectory, build.id, 'icon.png'));
  await fs.access(path.join(config.workspaceDirectory, build.id, 'site', 'index.html'));
  assert.equal(database.getBuild(build.id).ownerHash, owner);
});

test('a default icon is generated when none is supplied', async () => {
  const { service } = await createPipeline();
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  assert.equal(build.config.iconInfo.usingDefault, true);
});

test('zip builds report entry points and packaging warnings', async () => {
  const { service } = await createPipeline();
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig({ inputType: 'zip' }), source: sampleSiteZip(), icon: null });
  assert.equal(build.config.site.entryFile, 'index.html');
  assert.ok(build.config.warnings.some((warning) => warning.code === 'assets_may_be_ignored'));
});

test('url builds validate the website and record the final address', async () => {
  const { config, root } = await makeTestConfig();
  const database = createDatabase(':memory:');
  const probe = async () => ({ finalUrl: 'https://www.example.com/', status: 200, redirects: 1, secure: true, contentType: 'text/html' });
  const service = createBuildService({ config, database, queue: noopQueue(), probe });
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig({ inputType: 'url', url: 'https://example.com' }), source: null, icon: null });
  assert.deepEqual(build.config.remote, { startUrl: 'https://www.example.com/', host: 'www.example.com' });
  assert.deepEqual(build.config.warnings.map((warning) => warning.code), ['redirected', 'online_required']);
  const insecure = createBuildService({
    config,
    database,
    queue: noopQueue(),
    probe: async () => ({ finalUrl: 'http://example.com/', status: 200, redirects: 1, secure: false })
  });
  await assert.rejects(
    () => insecure.submit({ ownerHash: owner, rawConfig: validConfig({ inputType: 'url', url: 'https://example.com' }), source: null, icon: null }),
    (error) => error.code === 'https_required'
  );
  assert.equal(root.length > 0, true);
});

test('failed submissions leave no record and no workspace behind', async () => {
  const { service, database, config } = await createPipeline();
  const attempts = [
    { rawConfig: validConfig({ inputType: 'zip' }), source: Buffer.from('not a zip'), icon: null, code: 'invalid_zip' },
    { rawConfig: validConfig(), source: null, icon: null, code: 'missing_source' },
    { rawConfig: validConfig(), source: sampleHtml(), icon: Buffer.from('not an image'), code: 'unsupported_image' },
    { rawConfig: validConfig({ appName: '' }), source: sampleHtml(), icon: null, code: 'invalid_config' }
  ];
  for (const attempt of attempts) {
    await assert.rejects(
      () => service.submit({ ownerHash: owner, rawConfig: attempt.rawConfig, source: attempt.source, icon: attempt.icon }),
      (error) => error.code === attempt.code
    );
  }
  assert.equal(database.listBuilds(owner).length, 0);
  assert.deepEqual(await fs.readdir(config.workspaceDirectory), []);
});

test('a full queue removes the record and the workspace', async () => {
  const queue = new BuildQueue({ concurrency: 1, maxQueued: 1, timeoutMs: 5000, runner: () => new Promise(() => {}) });
  const { service, database, config } = await createPipeline({}, queue);
  queue.enqueue('occupied-running');
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue('occupied-pending');
  await assert.rejects(
    () => service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null }),
    (error) => error.code === 'queue_full'
  );
  assert.equal(database.listBuilds(owner).length, 0);
  assert.deepEqual(await fs.readdir(config.workspaceDirectory), []);
});

test('per client active build and storage quotas are enforced', async () => {
  const { service, database } = await createPipeline({ MAX_ACTIVE_BUILDS_PER_CLIENT: '1' });
  await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  await assert.rejects(
    () => service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null }),
    (error) => error.code === 'too_many_active_builds' && error.status === 429
  );
  await service.submit({ ownerHash: 'b'.repeat(64), rawConfig: validConfig(), source: sampleHtml(), icon: null });
  const full = await createPipeline({ MAX_STORAGE_MB_PER_CLIENT: '1' });
  const build = full.database.createBuild({ ownerHash: owner, appName: 'Old', inputType: 'html', config: {} });
  full.database.transition(build.id, 'preparing');
  full.database.transition(build.id, 'compiling');
  full.database.transition(build.id, 'validating');
  full.database.transition(build.id, 'completed', { artifact: { name: 'x.apk', size: 2 * 1024 * 1024, sha256: 'x' } });
  await assert.rejects(
    () => full.service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null }),
    (error) => error.code === 'storage_quota_exceeded'
  );
  assert.equal(database.stats(owner).active, 1);
});

test('runner with a stubbed gradle executable completes a build and stores the artifact', async () => {
  const { service, runner, database, config, root, events } = await createPipeline();
  await stubGradleSuccess(root);
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: await sampleIcon() });
  const published = [];
  events.subscribe(build.id, (event) => published.push(event.type));
  await runner(build.id, new AbortController().signal);
  const finished = database.getBuild(build.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.artifactName, `${build.id}.apk`);
  assert.match(finished.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(path.join(config.artifactDirectory, finished.artifactName))).size, finished.artifactSize);
  assert.ok(Date.parse(finished.expiresAt) > Date.now());
  await assert.rejects(() => fs.access(path.join(config.workspaceDirectory, build.id)));
  assert.equal(published.at(-1), 'end');
  assert.ok(published.includes('log'));
  const logs = database.getLogs(build.id).map((log) => log.line).join('\n');
  assert.match(logs, /BUILD SUCCESSFUL/);
  assert.ok(!logs.includes(config.workspaceDirectory));
  assert.match(logs, /<workspace>/);
});

test('runner reports gradle failures without leaking internal paths', async () => {
  const { service, runner, database, config, root } = await createPipeline();
  await writeExecutable(path.join(root, 'fake-gradle.sh'), `echo "error in $PWD" 1>&2\nexit 1`);
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  await runner(build.id, new AbortController().signal);
  const finished = database.getBuild(build.id);
  assert.equal(finished.state, 'failed');
  assert.ok(Date.parse(finished.expiresAt) > Date.now());
  assert.match(finished.errorSummary, /exit code 1/);
  assert.ok(!finished.errorSummary.includes(config.workspaceDirectory));
  assert.ok(!database.getLogs(build.id).some((log) => log.line.includes(config.workspaceDirectory)));
  await assert.rejects(() => fs.access(path.join(config.workspaceDirectory, build.id)));
});

test('runner fails a build whose gradle run produces no valid apk', async () => {
  const { service, runner, database, root } = await createPipeline();
  await writeExecutable(path.join(root, 'fake-gradle.sh'), `mkdir -p app/build/outputs/apk/debug\necho nope > app/build/outputs/apk/debug/app-debug.apk`);
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  await runner(build.id, new AbortController().signal);
  assert.equal(database.getBuild(build.id).state, 'failed');
  assert.match(database.getBuild(build.id).errorSummary, /not a valid APK/);
  assert.equal(database.getBuild(build.id).artifactName, null);
});

test('runner fails clearly when the android sdk is not configured', async () => {
  const { config, root } = await makeTestConfig();
  const bare = { ...config, androidHome: null };
  const database = createDatabase(':memory:');
  const events = createBuildEvents();
  const service = createBuildService({ config: bare, database, queue: noopQueue(), probe: publicProbe });
  const runner = createBuildRunner({ config: bare, database, events, logger: silentLogger });
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  await runner(build.id, new AbortController().signal);
  assert.equal(database.getBuild(build.id).state, 'failed');
  assert.match(database.getBuild(build.id).errorSummary, /Android SDK is not configured/);
  assert.equal(root.length > 0, true);
});

test('runner marks cancelled and timed out builds correctly', async () => {
  const { service, runner, database, root } = await createPipeline();
  await writeExecutable(path.join(root, 'fake-gradle.sh'), `echo working\nsleep 30 &\nwait`);
  const cancelled = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  const cancelController = new AbortController();
  const cancelRun = runner(cancelled.id, cancelController.signal);
  await waitFor(() => database.getBuild(cancelled.id).state === 'compiling');
  await waitFor(() => database.getLogs(cancelled.id).some((log) => log.line === 'working'));
  cancelController.abort(new DOMException('Build cancelled', 'AbortError'));
  await cancelRun;
  assert.equal(database.getBuild(cancelled.id).state, 'cancelled');
  const timedOut = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  const timeoutController = new AbortController();
  const timeoutRun = runner(timedOut.id, timeoutController.signal);
  await waitFor(() => database.getBuild(timedOut.id).state === 'compiling');
  await waitFor(() => database.getLogs(timedOut.id).some((log) => log.line === 'working'));
  timeoutController.abort(new DOMException('Build timed out', 'TimeoutError'));
  await timeoutRun;
  assert.equal(database.getBuild(timedOut.id).state, 'failed');
  assert.match(database.getBuild(timedOut.id).errorSummary, /time limit/);
});

test('runner skips builds that are already finished or missing', async () => {
  const { service, runner, database } = await createPipeline();
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  database.transition(build.id, 'cancelled');
  await runner(build.id, new AbortController().signal);
  assert.equal(database.getBuild(build.id).state, 'cancelled');
  await runner('f'.repeat(32), new AbortController().signal);
});

test('concurrent builds are isolated in separate workspaces', async () => {
  const { service, runner, database, config, root } = await createPipeline();
  const apk = path.join(root, 'prebuilt.apk');
  await fs.writeFile(apk, fakeApk());
  await writeExecutable(
    path.join(root, 'fake-gradle.sh'),
    `sleep 0.3\nmkdir -p app/build/outputs/apk/debug\ncp ${apk} app/build/outputs/apk/debug/app-debug.apk\necho "$PWD"`
  );
  const builds = [];
  for (const suffix of ['one', 'two', 'three']) {
    builds.push(await service.submit({ ownerHash: suffix.padEnd(64, '0'), rawConfig: validConfig({ appName: `App ${suffix}` }), source: sampleHtml(), icon: null }));
  }
  await Promise.all(builds.map((build) => runner(build.id, new AbortController().signal)));
  const names = builds.map((build) => database.getBuild(build.id).artifactName);
  assert.equal(new Set(names).size, 3);
  for (const build of builds) assert.equal(database.getBuild(build.id).state, 'completed');
  assert.deepEqual(await fs.readdir(config.workspaceDirectory), []);
});

test('runner keeps the log readable when the hosting platform probes a local Gradle port', async () => {
  const { service, runner, database, root } = await createPipeline();
  const apk = path.join(root, 'prebuilt.apk');
  await fs.writeFile(apk, fakeApk());
  const noise = Array.from({ length: 200 }, () => [
    'echo "Unable to receive command from client socket connection from /127.0.0.1:1 to /127.0.0.1:2. Discarding connection."',
    'echo "org.gradle.internal.remote.internal.MessageIOException: Could not read message from x."',
    'printf "\\tat org.gradle.internal.remote.internal.inet.SocketConnection.receive(SocketConnection.java:99)\\n"',
    'echo "Caused by: java.lang.IllegalArgumentException: Unexpected type tag 72 found."'
  ].join('\n')).join('\n');
  await writeExecutable(
    path.join(root, 'fake-gradle.sh'),
    `echo "> Task :app:preBuild"\n${noise}\necho "> Task :app:assembleDebug"\nmkdir -p app/build/outputs/apk/debug\ncp ${apk} app/build/outputs/apk/debug/app-debug.apk`
  );
  const build = await service.submit({ ownerHash: owner, rawConfig: validConfig(), source: sampleHtml(), icon: null });
  await runner(build.id, new AbortController().signal);
  assert.equal(database.getBuild(build.id).state, 'completed');
  const lines = database.getLogs(build.id, 0, 5000).map((log) => log.line);
  assert.ok(lines.length < 25, `log has ${lines.length} lines`);
  assert.ok(lines.includes('> Task :app:preBuild'));
  assert.ok(lines.includes('> Task :app:assembleDebug'));
  assert.ok(lines.some((line) => line.startsWith('Ignored 200 unexpected connection')));
  assert.ok(!lines.some((line) => line.includes('Unexpected type tag')));
});
