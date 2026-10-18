import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { buildGradleCommandArguments, buildGradleEnvironment, runGradle } from '../backend/src/build/gradleRunner.js';
import { makeTemporaryDirectory, makeTestConfig, waitFor, writeExecutable } from './helpers/fixtures.js';

const run = async (body, options = {}) => {
  const directory = await makeTemporaryDirectory('runner-');
  const script = path.join(directory, 'tool.sh');
  await writeExecutable(script, body);
  const lines = [];
  const controller = options.controller ?? new AbortController();
  const promise = runGradle({
    command: script,
    args: options.args ?? [],
    cwd: directory,
    env: options.env ?? { PATH: process.env.PATH },
    signal: controller.signal,
    onLine: (line) => lines.push(line),
    killGraceMs: options.killGraceMs ?? 200
  });
  return { promise, lines, controller, directory };
};

test('captures stdout and stderr lines and reports the exit code', async () => {
  const { promise, lines } = await run('echo first\necho second 1>&2\nprintf partial\nexit 3');
  const result = await promise;
  assert.equal(result.code, 3);
  assert.deepEqual(lines.sort(), ['first', 'partial', 'second']);
});

test('passes arguments verbatim without a shell', async () => {
  const { promise, lines } = await run('for argument in "$@"; do echo "[$argument]"; done', {
    args: ['a b', '$HOME', ';rm -rf /', '"quoted"']
  });
  await promise;
  assert.deepEqual(lines, ['[a b]', '[$HOME]', '[;rm -rf /]', '[\"quoted\"]']);
});

test('only the supplied environment is visible to the process', async () => {
  const { promise, lines } = await run('echo "api=[$API_KEY] custom=[$CUSTOM]"', { env: { PATH: process.env.PATH, CUSTOM: 'yes' } });
  await promise;
  assert.deepEqual(lines, ['api=[] custom=[yes]']);
});

test('aborting terminates the whole process group', async () => {
  const controller = new AbortController();
  const { promise, lines } = await run('echo started\nsleep 30 &\nwait', { controller });
  await waitFor(() => lines.includes('started'));
  const started = Date.now();
  controller.abort(new DOMException('Build cancelled', 'AbortError'));
  await assert.rejects(promise, (error) => error.name === 'AbortError');
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(lines, ['started']);
});

test('processes that ignore termination are killed after the grace period', async () => {
  const controller = new AbortController();
  const { promise, lines } = await run("trap '' TERM\necho ready\nwhile true; do sleep 1; done", { controller, killGraceMs: 300 });
  await waitFor(() => lines.includes('ready'));
  const started = Date.now();
  controller.abort(new DOMException('Build timed out', 'TimeoutError'));
  await assert.rejects(promise, (error) => error.name === 'TimeoutError');
  assert.ok(Date.now() - started < 4000);
});

test('an already aborted signal never starts the process', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Build cancelled', 'AbortError'));
  const { promise, lines } = await run('echo should-not-run', { controller });
  await assert.rejects(promise, (error) => error.name === 'AbortError');
  assert.deepEqual(lines, []);
});

test('a missing executable is reported without internal details', async () => {
  const controller = new AbortController();
  await assert.rejects(
    () => runGradle({ command: '/nonexistent/gradle', args: [], cwd: '/tmp', env: {}, signal: controller.signal, onLine: () => {} }),
    (error) => error.code === 'gradle_unavailable' && !error.message.includes('/nonexistent')
  );
});

test('the build environment excludes application secrets', async () => {
  const { config } = await makeTestConfig();
  const environment = buildGradleEnvironment(config, { PATH: '/usr/bin', JAVA_HOME: '/jdk', API_KEY: 'secret', DATABASE_FILE: '/x', AWS_SECRET_ACCESS_KEY: 'y' });
  assert.deepEqual(Object.keys(environment).sort(), ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_USER_HOME', 'GRADLE_OPTS', 'GRADLE_USER_HOME', 'HOME', 'JAVA_HOME', 'PATH']);
  assert.equal(environment.ANDROID_HOME, config.androidHome);
  assert.equal(environment.GRADLE_OPTS, '-Xmx2g');
});

test('gradle arguments are controlled and include project properties', async () => {
  const { config } = await makeTestConfig();
  const args = buildGradleCommandArguments(config, ['-Pinconnu.versionCode=2']);
  assert.deepEqual(args.slice(0, 3), ['--no-daemon', '--console=plain', 'assembleDebug']);
  assert.ok(!args.some((argument) => argument.includes('org.gradle.jvmargs')));
  assert.equal(args.at(-1), '-Pinconnu.versionCode=2');
});
