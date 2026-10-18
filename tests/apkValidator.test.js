import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { findBuildTool, validateApk } from '../backend/src/android/apkValidator.js';
import { buildZip } from './helpers/zipBuilder.js';
import { fakeApk, makeTemporaryDirectory } from './helpers/fixtures.js';

const writeApk = async (buffer) => {
  const directory = await makeTemporaryDirectory('apk-');
  const file = path.join(directory, 'app.apk');
  await fs.writeFile(file, buffer);
  return { directory, file };
};

test('accepts a structurally valid signed APK and reports a checksum', async () => {
  const { file } = await writeApk(fakeApk());
  const result = await validateApk(file, { expectedPackage: 'com.example.demo', expectedVersionCode: 1, androidHome: null });
  assert.equal(result.size, (await fs.stat(file)).size);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.checks.structure, 'verified');
  assert.equal(result.checks.metadata, 'skipped');
  assert.equal(result.checks.signatureVerification, 'skipped');
});

test('rejects files that are not archives and archives missing required entries', async () => {
  const notZip = await writeApk(Buffer.from('definitely not an apk'));
  await assert.rejects(() => validateApk(notZip.file, { androidHome: null }), (error) => error.code === 'invalid_apk');
  const incomplete = await writeApk(buildZip([{ name: 'classes.dex', data: 'x' }, { name: 'META-INF/CERT.RSA', data: 'x' }]));
  await assert.rejects(() => validateApk(incomplete.file, { androidHome: null }), (error) => error.code === 'invalid_apk' && /AndroidManifest/.test(error.message));
});

test('rejects unsigned APKs', async () => {
  const unsigned = await writeApk(buildZip([
    { name: 'AndroidManifest.xml', data: 'm' },
    { name: 'classes.dex', data: 'd' },
    { name: 'resources.arsc', data: 'r' }
  ]));
  await assert.rejects(() => validateApk(unsigned.file, { androidHome: null }), (error) => error.code === 'apk_unsigned');
});

test('accepts a v2 signing block without a META-INF signature file', async () => {
  const zip = buildZip([
    { name: 'AndroidManifest.xml', data: 'm' },
    { name: 'classes.dex', data: 'd' },
    { name: 'resources.arsc', data: 'r' }
  ]);
  const signed = Buffer.concat([Buffer.from('APK Sig Block 42'), zip]);
  const { file } = await writeApk(signed.subarray(16));
  await assert.rejects(() => validateApk(file, { androidHome: null }), (error) => error.code === 'apk_unsigned');
  const withMagic = await writeApk(buildZip([
    { name: 'AndroidManifest.xml', data: 'm' },
    { name: 'classes.dex', data: 'd' },
    { name: 'resources.arsc', data: 'r' },
    { name: 'assets/note.txt', data: 'APK Sig Block 42' }
  ]));
  const result = await validateApk(withMagic.file, { androidHome: null });
  assert.equal(result.checks.signaturePresent, 'verified');
});

test('uses aapt2 and apksigner when the Android build tools are available', async () => {
  const { directory, file } = await writeApk(fakeApk());
  const toolDirectory = path.join(directory, 'build-tools', '34.0.0');
  await fs.mkdir(toolDirectory, { recursive: true });
  await fs.mkdir(path.join(directory, 'build-tools', '9.0.0'), { recursive: true });
  for (const name of ['aapt2', 'apksigner']) await fs.writeFile(path.join(toolDirectory, name), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(await findBuildTool(directory, 'aapt2'), path.join(toolDirectory, 'aapt2'));
  const calls = [];
  const runTool = async (command, args) => {
    calls.push(path.basename(command));
    return { stdout: "package: name='com.example.demo' versionCode='7' versionName='1.2.3'\n" };
  };
  const result = await validateApk(file, { expectedPackage: 'com.example.demo', expectedVersionCode: 7, androidHome: directory, runTool });
  assert.deepEqual(calls, ['aapt2', 'apksigner']);
  assert.equal(result.checks.metadata, 'verified');
  assert.equal(result.checks.signatureVerification, 'verified');
});

test('metadata mismatches and signature failures are rejected', async () => {
  const { directory, file } = await writeApk(fakeApk());
  const toolDirectory = path.join(directory, 'build-tools', '34.0.0');
  await fs.mkdir(toolDirectory, { recursive: true });
  for (const name of ['aapt2', 'apksigner']) await fs.writeFile(path.join(toolDirectory, name), '#!/bin/sh\n', { mode: 0o755 });
  const wrongPackage = async () => ({ stdout: "package: name='other.app' versionCode='7' versionName='1'\n" });
  await assert.rejects(
    () => validateApk(file, { expectedPackage: 'com.example.demo', expectedVersionCode: 7, androidHome: directory, runTool: wrongPackage }),
    (error) => error.code === 'apk_metadata_mismatch'
  );
  const failingSigner = async (command) => {
    if (command.endsWith('apksigner')) throw new Error('bad signature');
    return { stdout: "package: name='com.example.demo' versionCode='7' versionName='1'\n" };
  };
  await assert.rejects(
    () => validateApk(file, { expectedPackage: 'com.example.demo', expectedVersionCode: 7, androidHome: directory, runTool: failingSigner }),
    (error) => error.code === 'apk_signature_invalid'
  );
});

test('missing build tools are reported as null', async () => {
  assert.equal(await findBuildTool(null, 'aapt2'), null);
  assert.equal(await findBuildTool('/nonexistent-sdk', 'aapt2'), null);
});
