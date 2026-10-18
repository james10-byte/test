import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOISE_NOTICE, createLogFilter } from '../backend/src/build/logFilter.js';

const NOISE_BLOCK = [
  'Unable to receive command from client socket connection from /127.0.0.1:34945 to /127.0.0.1:46976. Discarding connection.',
  "org.gradle.internal.remote.internal.MessageIOException: Could not read message from '/127.0.0.1:46976'.",
  '\tat org.gradle.internal.remote.internal.inet.SocketConnection.receive(SocketConnection.java:99)',
  '\tat org.gradle.launcher.daemon.server.SynchronizedDispatchConnection.receive(SynchronizedDispatchConnection.java:70)',
  '\tat java.base/java.lang.Thread.run(Thread.java:840)',
  'Caused by: java.lang.IllegalArgumentException: Unexpected type tag 72 found.',
  '\tat org.gradle.internal.serialize.DefaultSerializerRegistry$TaggedTypeSerializer.read(DefaultSerializerRegistry.java:162)',
  '\t... 7 more'
];

const collect = () => {
  const lines = [];
  const filter = createLogFilter((line) => lines.push(line));
  return { lines, filter };
};

test('repeated daemon port noise collapses into a single notice', () => {
  const { lines, filter } = collect();
  filter.push('Starting a Gradle Daemon');
  for (let index = 0; index < 50; index += 1) for (const line of NOISE_BLOCK) filter.push(line);
  filter.push('> Task :app:preBuild');
  assert.deepEqual(lines, ['Starting a Gradle Daemon', NOISE_NOTICE, '> Task :app:preBuild']);
  assert.equal(filter.ignoredCount(), 50);
});

test('real errors and stack traces outside the noise are kept', () => {
  const { lines, filter } = collect();
  for (const line of NOISE_BLOCK) filter.push(line);
  filter.push('FAILURE: Build failed with an exception.');
  filter.push('* What went wrong:');
  filter.push('Execution failed for task :app:compileDebugKotlin.');
  filter.push('\tat org.jetbrains.kotlin.Something.run(Something.kt:10)');
  assert.deepEqual(lines, [
    NOISE_NOTICE,
    'FAILURE: Build failed with an exception.',
    '* What went wrong:',
    'Execution failed for task :app:compileDebugKotlin.',
    '\tat org.jetbrains.kotlin.Something.run(Something.kt:10)'
  ]);
  assert.equal(filter.ignoredCount(), 1);
});

test('output without noise passes through unchanged', () => {
  const { lines, filter } = collect();
  for (const line of ['a', '', 'b']) filter.push(line);
  assert.deepEqual(lines, ['a', '', 'b']);
  assert.equal(filter.ignoredCount(), 0);
});
