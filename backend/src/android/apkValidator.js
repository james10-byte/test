import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
import { readZipEntries } from '../security/zipSafe.js';

const execute = promisify(execFile);
const REQUIRED_ENTRIES = ['AndroidManifest.xml', 'classes.dex', 'resources.arsc'];
const SIGNING_BLOCK_MAGIC = Buffer.from('APK Sig Block 42');
const BADGING_PATTERN = /package: name='([^']+)' versionCode='(\d+)'/;
const TOOL_TIMEOUT_MS = 30000;

export async function findBuildTool(androidHome, name) {
  if (!androidHome) return null;
  const root = path.join(androidHome, 'build-tools');
  let versions;
  try {
    versions = await fs.readdir(root);
  } catch {
    return null;
  }
  versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(root, version, name);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function validateApk(file, { expectedPackage, expectedVersionCode, androidHome, runTool = execute }) {
  const buffer = await fs.readFile(file);
  let entries;
  try {
    ({ entries } = readZipEntries(buffer, {
      maxCompressedBytes: buffer.length + 1,
      maxExtractedBytes: 2 ** 31,
      maxEntryBytes: 2 ** 31,
      maxFiles: 100000,
      maxDepth: 64
    }));
  } catch {
    throw new AppError(500, 'invalid_apk', 'The generated file is not a valid APK archive.');
  }
  const names = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.relativePath));
  const missing = REQUIRED_ENTRIES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new AppError(500, 'invalid_apk', `The generated APK is missing required entries: ${missing.join(', ')}.`);
  }
  const hasV1Signature = [...names].some((name) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name));
  if (!hasV1Signature && !buffer.includes(SIGNING_BLOCK_MAGIC)) {
    throw new AppError(500, 'apk_unsigned', 'The generated APK is not signed.');
  }
  const checks = {
    structure: 'verified',
    signaturePresent: 'verified',
    metadata: 'skipped',
    signatureVerification: 'skipped'
  };
  const aapt2 = await findBuildTool(androidHome, 'aapt2');
  if (aapt2) {
    let output;
    try {
      ({ stdout: output } = await runTool(aapt2, ['dump', 'badging', file], {
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      }));
    } catch {
      throw new AppError(500, 'apk_metadata_unreadable', 'The APK metadata could not be read.');
    }
    const match = BADGING_PATTERN.exec(output);
    if (!match || match[1] !== expectedPackage || Number(match[2]) !== expectedVersionCode) {
      throw new AppError(500, 'apk_metadata_mismatch', 'The APK metadata does not match the requested configuration.');
    }
    checks.metadata = 'verified';
  }
  const apksigner = await findBuildTool(androidHome, 'apksigner');
  if (apksigner) {
    try {
      await runTool(apksigner, ['verify', file], { timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    } catch {
      throw new AppError(500, 'apk_signature_invalid', 'The APK signature could not be verified.');
    }
    checks.signatureVerification = 'verified';
  }
  return { size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), checks };
}
