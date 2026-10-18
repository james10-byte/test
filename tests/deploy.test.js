import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { createDatabase } from '../backend/src/db/database.js';
import { REPOSITORY_ROOT, createSandbox, git } from './helpers/sandbox.js';

const sandboxes = [];
const newSandbox = async (options) => {
  const sandbox = await createSandbox(options);
  sandboxes.push(sandbox);
  return sandbox;
};

after(async () => {
  for (const sandbox of sandboxes) await sandbox.cleanup();
});

const exists = (file) => fs.access(file).then(() => true, () => false);

async function installedSandbox(arguments_ = ['--domain', 'apk.example.com']) {
  const sandbox = await newSandbox();
  const result = sandbox.install(arguments_);
  assert.equal(result.status, 0, result.output);
  return sandbox;
}

function seedData(sandbox, buildName = 'First') {
  const data = path.join(sandbox.installDirectory, 'data');
  const database = createDatabase(path.join(data, 'metadata.sqlite'));
  const build = database.createBuild({ ownerHash: 'o'.repeat(64), appName: buildName, inputType: 'html', config: {} });
  database.close();
  return { data, buildId: build.id };
}

test('installer help and unknown options', async () => {
  const sandbox = await newSandbox();
  const help = sandbox.install(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.output, /--domain/);
  const unknown = sandbox.install(['--bogus']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.output, /Unknown option/);
});

test('dry run performs every check and changes nothing', async () => {
  const sandbox = await newSandbox();
  const result = sandbox.install(['--dry-run', '--domain', 'apk.example.com']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Dry run complete/);
  assert.match(result.output, /https:\/\/apk\.example\.com/);
  assert.equal(await exists(sandbox.installDirectory), false);
  assert.equal((await sandbox.calls()).filter((call) => call.startsWith('docker compose')).length, 0);
});

test('unsupported operating systems are rejected with a clear message', async () => {
  const sandbox = await newSandbox({ osRelease: 'ID=fedora\nVERSION_ID="40"\n' });
  const result = sandbox.install(['--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Unsupported operating system 'fedora 40'/);
});

test('insufficient memory and disk are reported before anything is changed', async () => {
  const sandbox = await newSandbox();
  const memory = sandbox.install(['--dry-run'], { MIN_MEMORY_MB: '999999999' });
  assert.notEqual(memory.status, 0);
  assert.match(memory.output, /memory/);
  const disk = sandbox.install(['--dry-run'], { MIN_DISK_MB: '999999999' });
  assert.notEqual(disk.status, 0);
  assert.match(disk.output, /disk space/);
  assert.equal(await exists(sandbox.installDirectory), false);
});

test('privileges, domains, versions and directories are validated', async () => {
  const sandbox = await newSandbox();
  if (process.getuid && process.getuid() !== 0) {
    const nonRoot = sandbox.install(['--dry-run'], { INCONNU_SKIP_ROOT_CHECK: '0' });
    assert.match(nonRoot.output, /must run as root/);
  }
  assert.match(sandbox.install(['--dry-run', '--domain', 'not a domain']).output, /not a valid domain/);
  assert.match(sandbox.install(['--dry-run', '--domain', 'a;rm -rf /.com']).output, /not a valid domain/);
  assert.match(sandbox.install(['--dry-run', '--version', 'main; reboot']).output, /not a valid branch or tag/);
  assert.match(sandbox.install(['--dry-run', '--dir', 'relative/path']).output, /absolute path/);
  const unreachable = sandbox.install(['--dry-run'], { NETWORK_CHECK_URL: 'https://example.invalid' });
  assert.equal(unreachable.status, 0);
});

test('a full installation with a domain configures HTTPS, permissions and data directories', async () => {
  const sandbox = await installedSandbox();
  const env = await fs.readFile(path.join(sandbox.installDirectory, '.env'), 'utf8');
  assert.match(env, /^NODE_ENV=production$/m);
  assert.match(env, /^PUBLIC_BASE_URL=https:\/\/apk\.example\.com$/m);
  assert.match(env, /^DOMAIN=apk\.example\.com$/m);
  assert.match(env, /^TRUST_PROXY=true$/m);
  assert.match(env, /^BIND_ADDRESS=127\.0\.0\.1$/m);
  assert.equal((await fs.stat(path.join(sandbox.installDirectory, '.env'))).mode & 0o777, 0o600);
  for (const directory of ['artifacts', 'workspaces', 'gradle-home', 'build-home', 'snapshots']) {
    assert.equal(await exists(path.join(sandbox.installDirectory, 'data', directory)), true, directory);
  }
  if (process.getuid && process.getuid() === 0) {
    assert.equal((await fs.stat(path.join(sandbox.installDirectory, 'data'))).uid, 10001);
  }
  const calls = await sandbox.calls();
  assert.ok(calls.some((call) => call.includes('--profile https') && call.includes(' build')));
  assert.ok(calls.some((call) => call.includes('--profile https') && call.includes(' up -d')));
  assert.ok(calls.every((call) => !call.includes('docker.sock')));
});

test('an installation without a domain uses plain http and explains how to enable https', async () => {
  const sandbox = await newSandbox();
  const result = sandbox.install([]);
  assert.equal(result.status, 0, result.output);
  const env = await fs.readFile(path.join(sandbox.installDirectory, '.env'), 'utf8');
  assert.match(env, /^NODE_ENV=staging$/m);
  assert.match(env, /^BIND_ADDRESS=0\.0\.0\.0$/m);
  assert.match(result.output, /set-domain\.sh/);
  assert.match(result.output, /http:\/\//);
  const calls = await sandbox.calls();
  assert.ok(calls.every((call) => !call.includes('--profile')));
});

test('running the installer again never replaces an existing installation', async () => {
  const sandbox = await installedSandbox();
  const envFile = path.join(sandbox.installDirectory, '.env');
  await fs.appendFile(envFile, 'CUSTOM_SECRET=keep-me\n');
  await fs.writeFile(path.join(sandbox.installDirectory, 'data', 'marker.txt'), 'data');
  await sandbox.clearCalls();
  const again = sandbox.install(['--domain', 'other.example.com']);
  assert.equal(again.status, 0);
  assert.match(again.output, /already exists/);
  assert.match(await fs.readFile(envFile, 'utf8'), /CUSTOM_SECRET=keep-me/);
  assert.match(await fs.readFile(envFile, 'utf8'), /DOMAIN=apk\.example\.com/);
  assert.equal(await fs.readFile(path.join(sandbox.installDirectory, 'data', 'marker.txt'), 'utf8'), 'data');
  assert.equal((await sandbox.calls()).filter((call) => call.startsWith('docker compose')).length, 0);
});

test('a non-empty unrelated directory is refused', async () => {
  const sandbox = await newSandbox();
  await fs.mkdir(sandbox.installDirectory, { recursive: true });
  await fs.writeFile(path.join(sandbox.installDirectory, 'something.txt'), 'x');
  const result = sandbox.install([]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /not empty/);
  assert.equal(await fs.readFile(path.join(sandbox.installDirectory, 'something.txt'), 'utf8'), 'x');
});

test('a service that never becomes healthy is reported as a failure with logs', async () => {
  const sandbox = await newSandbox();
  await fs.writeFile(path.join(sandbox.state, 'unhealthy'), '');
  const result = sandbox.install([], { HEALTH_TIMEOUT: '3' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Health check failed/);
  assert.match(result.output, /stub application log/);
});

test('a failing image build stops the installer without claiming success', async () => {
  const sandbox = await newSandbox();
  await fs.writeFile(path.join(sandbox.state, 'fail-build'), '');
  const result = sandbox.install([]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.output, /is running/);
  assert.match(result.output, /stopped at line/);
});

test('the update script pulls changes and preserves configuration, metadata and artifacts', async () => {
  const sandbox = await installedSandbox();
  const { data, buildId } = seedData(sandbox);
  await fs.writeFile(path.join(data, 'artifacts', 'kept.apk'), 'apk-bytes');
  const envBefore = await fs.readFile(path.join(sandbox.installDirectory, '.env'), 'utf8');
  await sandbox.pushCommit({ VERSION: 'two\n' });
  await sandbox.clearCalls();
  const result = sandbox.script('update.sh', ['--yes']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Updated to/);
  assert.equal(await fs.readFile(path.join(sandbox.installDirectory, 'VERSION'), 'utf8'), 'two\n');
  const envAfter = await fs.readFile(path.join(sandbox.installDirectory, '.env'), 'utf8');
  assert.equal(envAfter.replace(/^APP_VERSION=.*$/m, ''), envBefore.replace(/^APP_VERSION=.*$/m, ''));
  assert.equal(await fs.readFile(path.join(data, 'artifacts', 'kept.apk'), 'utf8'), 'apk-bytes');
  const database = createDatabase(path.join(data, 'metadata.sqlite'));
  assert.equal(database.getBuild(buildId).appName, 'First');
  database.close();
  const backups = await fs.readdir(sandbox.backupDirectory);
  assert.equal(backups.length, 1);
  const calls = await sandbox.calls();
  assert.ok(calls.some((call) => call.includes(' build')));
  assert.ok(calls.some((call) => call.includes(' up -d')));
});

test('the update script is a no-op when already up to date', async () => {
  const sandbox = await installedSandbox();
  await sandbox.clearCalls();
  const result = sandbox.script('update.sh', ['--no-backup']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Already up to date/);
  assert.equal((await sandbox.calls()).filter((call) => call.includes(' build')).length, 0);
});

test('a failed update is rolled back without touching data', async () => {
  const sandbox = await installedSandbox();
  const { data } = seedData(sandbox);
  await sandbox.pushCommit({ VERSION: 'broken\n' });
  await fs.writeFile(path.join(sandbox.state, 'fail-build'), '');
  const before = git(sandbox.installDirectory, 'rev-parse', 'HEAD').trim();
  const result = sandbox.script('update.sh', ['--no-backup']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /rolled back/);
  assert.equal(git(sandbox.installDirectory, 'rev-parse', 'HEAD').trim(), before);
  assert.equal(await fs.readFile(path.join(sandbox.installDirectory, 'VERSION'), 'utf8'), 'one\n');
  assert.equal(await exists(path.join(data, 'metadata.sqlite')), true);
});

test('an update whose service is unhealthy is rolled back', async () => {
  const sandbox = await installedSandbox();
  await sandbox.pushCommit({ VERSION: 'unhealthy\n' });
  await fs.writeFile(path.join(sandbox.state, 'unhealthy'), '');
  const result = sandbox.script('update.sh', ['--no-backup'], { HEALTH_TIMEOUT: '2' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /rolled back/);
  assert.equal(await fs.readFile(path.join(sandbox.installDirectory, 'VERSION'), 'utf8'), 'one\n');
});

test('the update script refuses local modifications and unsafe version names', async () => {
  const sandbox = await installedSandbox();
  await fs.appendFile(path.join(sandbox.installDirectory, 'VERSION'), 'local edit\n');
  const dirty = sandbox.script('update.sh', ['--no-backup']);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.output, /local changes/);
  git(sandbox.installDirectory, 'checkout', '--', 'VERSION');
  const unsafe = sandbox.script('update.sh', ['--no-backup', '--version', 'x; reboot']);
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.output, /not a valid branch or tag/);
});

test('the update script can install a tagged version', async () => {
  const sandbox = await installedSandbox();
  await sandbox.pushCommit({ VERSION: 'tagged\n' });
  const work = path.join(sandbox.root, 'tagger');
  execFileSync('git', ['clone', '--quiet', sandbox.origin, work]);
  git(work, 'tag', 'v1.0.0');
  git(work, 'push', '--quiet', 'origin', 'v1.0.0');
  await sandbox.pushCommit({ VERSION: 'after-tag\n' });
  const result = sandbox.script('update.sh', ['--no-backup', '--version', 'v1.0.0']);
  assert.equal(result.status, 0, result.output);
  assert.equal(await fs.readFile(path.join(sandbox.installDirectory, 'VERSION'), 'utf8'), 'tagged\n');
  assert.match(await fs.readFile(path.join(sandbox.installDirectory, '.env'), 'utf8'), /^APP_VERSION=v1\.0\.0$/m);
  const pinned = sandbox.script('update.sh', ['--no-backup']);
  assert.notEqual(pinned.status, 0);
  assert.match(pinned.output, /pinned to a tag/);
});

async function archiveEntries(file) {
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

test('backup produces a consistent private archive with a verifiable manifest', async () => {
  const sandbox = await installedSandbox();
  const { data } = seedData(sandbox);
  await fs.writeFile(path.join(data, 'artifacts', 'one.apk'), 'apk-one');
  const result = sandbox.script('backup.sh');
  assert.equal(result.status, 0, result.output);
  const [name] = await fs.readdir(sandbox.backupDirectory);
  const archive = path.join(sandbox.backupDirectory, name);
  assert.equal((await fs.stat(archive)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(sandbox.backupDirectory)).mode & 0o777, 0o700);
  const entries = await archiveEntries(archive);
  for (const expected of ['metadata.sqlite', 'backup-manifest.json', 'artifacts/one.apk', '.env']) assert.ok(entries.includes(expected), expected);
  const extracted = path.join(sandbox.root, 'extracted');
  await fs.mkdir(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'backup-manifest.json'), 'utf8'));
  assert.equal(manifest.artifactCount, 1);
  assert.equal(manifest.includesEnvironment, true);
  const digest = execFileSync('sha256sum', [path.join(extracted, 'metadata.sqlite')], { encoding: 'utf8' }).split(' ')[0];
  assert.equal(manifest.databaseSha256, digest);
  const verification = execFileSync('node', [path.join(REPOSITORY_ROOT, 'scripts/check-database.mjs'), path.join(extracted, 'metadata.sqlite')], { encoding: 'utf8' });
  assert.match(verification, /ok builds=1/);
  assert.deepEqual(await fs.readdir(path.join(data, 'snapshots')), []);
});

test('backup can exclude the environment file and prunes old archives', async () => {
  const sandbox = await installedSandbox();
  seedData(sandbox);
  const first = sandbox.script('backup.sh', ['--no-env'], { BACKUP_KEEP: '2' });
  assert.equal(first.status, 0, first.output);
  const [name] = await fs.readdir(sandbox.backupDirectory);
  assert.ok(!(await archiveEntries(path.join(sandbox.backupDirectory, name))).includes('.env'));
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(sandbox.script('backup.sh', ['--quiet'], { BACKUP_KEEP: '2' }).status, 0);
  }
  assert.equal((await fs.readdir(sandbox.backupDirectory)).length, 2);
});

test('backup fails clearly when the database is missing or the service is down', async () => {
  const sandbox = await installedSandbox();
  const missing = sandbox.script('backup.sh');
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /No database found/);
  seedData(sandbox);
  await fs.writeFile(path.join(sandbox.state, 'fail-exec'), '');
  const down = sandbox.script('backup.sh');
  assert.notEqual(down.status, 0);
  assert.match(down.output, /snapshot failed/);
  assert.deepEqual(await fs.readdir(sandbox.backupDirectory), []);
});

function makeArchive(directory, name, populate) {
  const stage = path.join(directory, `stage-${name}`);
  return fs.mkdir(stage, { recursive: true }).then(async () => {
    await populate(stage);
    const archive = path.join(directory, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', stage, ...(await fs.readdir(stage, { withFileTypes: true })).map((entry) => entry.name)]);
    return archive;
  });
}

test('restore replaces data after validating the backup and keeps the previous data aside', async () => {
  const sandbox = await installedSandbox();
  const { data } = seedData(sandbox, 'Original');
  await fs.writeFile(path.join(data, 'artifacts', 'original.apk'), 'original');
  assert.equal(sandbox.script('backup.sh', ['--quiet']).status, 0);
  const [name] = await fs.readdir(sandbox.backupDirectory);
  const archive = path.join(sandbox.backupDirectory, name);
  const database = createDatabase(path.join(data, 'metadata.sqlite'));
  database.createBuild({ ownerHash: 'o'.repeat(64), appName: 'Added later', inputType: 'html', config: {} });
  database.close();
  await fs.rm(path.join(data, 'artifacts', 'original.apk'));
  await fs.writeFile(path.join(data, 'artifacts', 'newer.apk'), 'newer');
  await sandbox.clearCalls();
  const result = sandbox.script('restore.sh', [archive, '--yes']);
  assert.equal(result.status, 0, result.output);
  const restored = createDatabase(path.join(data, 'metadata.sqlite'));
  assert.deepEqual(restored.listBuilds('o'.repeat(64)).map((build) => build.appName), ['Original']);
  restored.close();
  assert.equal(await fs.readFile(path.join(data, 'artifacts', 'original.apk'), 'utf8'), 'original');
  assert.equal(await exists(path.join(data, 'artifacts', 'newer.apk')), false);
  const aside = (await fs.readdir(data)).find((entry) => entry.startsWith('pre-restore-'));
  assert.ok(aside);
  assert.equal(await fs.readFile(path.join(data, aside, 'artifacts', 'newer.apk'), 'utf8'), 'newer');
  const calls = await sandbox.calls();
  assert.ok(calls.some((call) => call.includes(' stop')));
  assert.ok(calls.some((call) => call.includes(' up -d')));
});

test('restore rejects unsafe, tampered and incomplete archives before touching anything', async () => {
  const sandbox = await installedSandbox();
  const { data } = seedData(sandbox);
  const marker = path.join(data, 'artifacts', 'marker.apk');
  await fs.writeFile(marker, 'keep');
  const good = await makeArchive(sandbox.root, 'good', async (stage) => {
    await fs.copyFile(path.join(data, 'metadata.sqlite'), path.join(stage, 'metadata.sqlite'));
    const digest = execFileSync('sha256sum', [path.join(stage, 'metadata.sqlite')], { encoding: 'utf8' }).split(' ')[0];
    await fs.writeFile(path.join(stage, 'backup-manifest.json'), `{\n  "databaseSha256": "${digest}"\n}\n`);
  });
  const expectRejected = (archive, pattern) => {
    const result = sandbox.script('restore.sh', [archive, '--yes']);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, pattern);
  };
  const notArchive = path.join(sandbox.root, 'plain.tar.gz');
  await fs.writeFile(notArchive, 'plain text');
  expectRejected(notArchive, /not a readable tar\.gz/);
  expectRejected(path.join(sandbox.root, 'missing.tar.gz'), /not found/);
  const traversal = path.join(sandbox.root, 'traversal.tar.gz');
  execFileSync('python3', ['-c', `
import tarfile, io, sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
    for name in ['metadata.sqlite', 'backup-manifest.json', '../evil.txt']:
        data = b'x'
        info = tarfile.TarInfo(name)
        info.size = 1
        t.addfile(info, io.BytesIO(data))
`, traversal]);
  expectRejected(traversal, /unsafe path/);
  const absolute = path.join(sandbox.root, 'absolute.tar.gz');
  execFileSync('python3', ['-c', `
import tarfile, io, sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
    info = tarfile.TarInfo('/etc/evil')
    info.size = 1
    t.addfile(info, io.BytesIO(b'x'))
`, absolute]);
  expectRejected(absolute, /unsafe path/);
  const link = path.join(sandbox.root, 'link.tar.gz');
  execFileSync('python3', ['-c', `
import tarfile, io, sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
    for name in ['metadata.sqlite', 'backup-manifest.json']:
        info = tarfile.TarInfo(name)
        info.size = 1
        t.addfile(info, io.BytesIO(b'x'))
    symlink = tarfile.TarInfo('artifacts')
    symlink.type = tarfile.SYMTYPE
    symlink.linkname = '/etc'
    t.addfile(symlink)
`, link]);
  expectRejected(link, /links, which are not allowed/);
  const unexpected = await makeArchive(sandbox.root, 'unexpected', async (stage) => {
    await fs.writeFile(path.join(stage, 'metadata.sqlite'), 'x');
    await fs.writeFile(path.join(stage, 'backup-manifest.json'), '{}');
    await fs.writeFile(path.join(stage, 'extra.sh'), 'x');
  });
  expectRejected(unexpected, /unexpected entry/);
  const noManifest = await makeArchive(sandbox.root, 'nomanifest', async (stage) => {
    await fs.writeFile(path.join(stage, 'metadata.sqlite'), 'x');
  });
  expectRejected(noManifest, /no manifest/);
  const tampered = await makeArchive(sandbox.root, 'tampered', async (stage) => {
    await fs.copyFile(path.join(data, 'metadata.sqlite'), path.join(stage, 'metadata.sqlite'));
    await fs.writeFile(path.join(stage, 'backup-manifest.json'), `{ "databaseSha256": "${'0'.repeat(64)}" }`);
  });
  expectRejected(tampered, /checksum does not match/);
  const corrupt = await makeArchive(sandbox.root, 'corrupt', async (stage) => {
    await fs.writeFile(path.join(stage, 'metadata.sqlite'), 'this is not a database');
    const digest = execFileSync('sha256sum', [path.join(stage, 'metadata.sqlite')], { encoding: 'utf8' }).split(' ')[0];
    await fs.writeFile(path.join(stage, 'backup-manifest.json'), `{ "databaseSha256": "${digest}" }`);
  });
  expectRejected(corrupt, /integrity check/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
  assert.equal(await exists(path.join(data, 'metadata.sqlite')), true);
  assert.ok(!(await fs.readdir(data)).some((entry) => entry.startsWith('pre-restore-')));
  assert.ok(good);
});

test('restore without confirmation changes nothing, and a restore that fails health is reverted', async () => {
  const sandbox = await installedSandbox();
  const { data } = seedData(sandbox, 'Current');
  assert.equal(sandbox.script('backup.sh', ['--quiet']).status, 0);
  const [name] = await fs.readdir(sandbox.backupDirectory);
  const archive = path.join(sandbox.backupDirectory, name);
  const database = createDatabase(path.join(data, 'metadata.sqlite'));
  database.createBuild({ ownerHash: 'o'.repeat(64), appName: 'Newer', inputType: 'html', config: {} });
  database.close();
  const declined = sandbox.script('restore.sh', [archive]);
  assert.notEqual(declined.status, 0);
  assert.match(declined.output, /Confirmation required/);
  await fs.writeFile(path.join(sandbox.state, 'unhealthy'), '');
  const reverted = sandbox.script('restore.sh', [archive, '--yes'], { HEALTH_TIMEOUT: '2' });
  assert.notEqual(reverted.status, 0);
  assert.match(reverted.output, /previous data was put back/);
  const after = createDatabase(path.join(data, 'metadata.sqlite'));
  assert.deepEqual(after.listBuilds('o'.repeat(64)).map((build) => build.appName).sort(), ['Current', 'Newer']);
  after.close();
});

test('uninstall keeps data by default and requires explicit confirmation to purge', async () => {
  const sandbox = await installedSandbox();
  const { data } = seedData(sandbox);
  const noTerminal = sandbox.script('uninstall.sh');
  assert.notEqual(noTerminal.status, 0);
  assert.match(noTerminal.output, /Confirmation required/);
  const kept = sandbox.script('uninstall.sh', ['--yes']);
  assert.equal(kept.status, 0, kept.output);
  assert.equal(await exists(path.join(data, 'metadata.sqlite')), true);
  assert.ok((await sandbox.calls()).some((call) => call.includes(' down')));
  const unconfirmed = sandbox.script('uninstall.sh', ['--purge']);
  assert.notEqual(unconfirmed.status, 0);
  assert.match(unconfirmed.output, /--confirm DELETE/);
  const wrong = sandbox.script('uninstall.sh', ['--purge', '--confirm', 'yes']);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.output, /did not match/);
  assert.equal(await exists(path.join(data, 'metadata.sqlite')), true);
});

test('purging removes the installation but never the backups', async () => {
  const sandbox = await installedSandbox();
  seedData(sandbox);
  assert.equal(sandbox.script('backup.sh', ['--quiet']).status, 0);
  const result = sandbox.script('uninstall.sh', ['--purge', '--confirm', 'DELETE']);
  assert.equal(result.status, 0, result.output);
  assert.equal(await exists(sandbox.installDirectory), false);
  assert.equal((await fs.readdir(sandbox.backupDirectory)).length, 1);
  assert.match(result.output, /Backups .* were left in place/);
});

test('uninstall refuses unsafe installation paths', async () => {
  const sandbox = await installedSandbox();
  const result = sandbox.script('uninstall.sh', ['--purge', '--confirm', 'DELETE'], { INSTALL_DIR: '/opt' });
  assert.notEqual(result.status, 0);
  assert.equal(await exists(sandbox.installDirectory), true);
});

test('the doctor reports a healthy installation and flags problems with a failing exit code', async () => {
  const sandbox = await installedSandbox();
  const healthy = sandbox.script('doctor.sh');
  assert.equal(healthy.status, 0, healthy.output);
  assert.match(healthy.output, /Health endpoint answers/);
  assert.match(healthy.output, /\.env exists with permissions 600/);
  assert.match(healthy.output, /No backup found/);
  assert.match(healthy.output, /0 problem\(s\)/);
  await fs.writeFile(path.join(sandbox.state, 'unhealthy'), '');
  const broken = sandbox.script('doctor.sh', [], { STUB_PS: 'app exited' });
  assert.notEqual(broken.status, 0);
  assert.match(broken.output, /app container is not running/);
  assert.match(broken.output, /Health endpoint does not answer/);
  await fs.rm(path.join(sandbox.installDirectory, '.env'));
  const missing = sandbox.script('doctor.sh');
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /\.env is missing/);
});

test('the doctor works without an installation', async () => {
  const sandbox = await newSandbox();
  const result = sandbox.run(path.join(REPOSITORY_ROOT, 'scripts/doctor.sh'), [], { INSTALL_DIR: sandbox.installDirectory });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /No installation found/);
});

test('set-domain enables https and restores the previous configuration on failure', async () => {
  const sandbox = await installedSandbox([]);
  const envFile = path.join(sandbox.installDirectory, '.env');
  const invalid = sandbox.script('set-domain.sh', ['bad domain']);
  assert.notEqual(invalid.status, 0);
  const result = sandbox.script('set-domain.sh', ['secure.example.com']);
  assert.equal(result.status, 0, result.output);
  const env = await fs.readFile(envFile, 'utf8');
  assert.match(env, /^DOMAIN=secure\.example\.com$/m);
  assert.match(env, /^NODE_ENV=production$/m);
  assert.match(env, /^BIND_ADDRESS=127\.0\.0\.1$/m);
  assert.ok((await sandbox.calls()).some((call) => call.includes('--profile https') && call.includes(' up -d')));
  const before = await fs.readFile(envFile, 'utf8');
  await fs.writeFile(path.join(sandbox.state, 'unhealthy'), '');
  const failed = sandbox.script('set-domain.sh', ['another.example.com'], { HEALTH_TIMEOUT: '2' });
  assert.notEqual(failed.status, 0);
  assert.equal(await fs.readFile(envFile, 'utf8'), before);
});

test('scripts are strict, valid bash and free of dangerous patterns', async () => {
  const files = ['install.sh', ...(await fs.readdir(path.join(REPOSITORY_ROOT, 'scripts'), { recursive: true })).filter((entry) => entry.endsWith('.sh')).map((entry) => `scripts/${entry}`)];
  assert.ok(files.length >= 9);
  for (const file of files) {
    const source = await fs.readFile(path.join(REPOSITORY_ROOT, file), 'utf8');
    assert.match(source.split('\n')[0], /^#!\/usr\/bin\/env bash$/, file);
    if (!file.endsWith('common.sh')) assert.match(source, /^set -[A-Za-z]*e[A-Za-z]*u?[A-Za-z]* ?(-o pipefail)?|^set -Eeuo pipefail|^set -uo pipefail|^set -eu/m, `${file} is not strict`);
    assert.doesNotMatch(source, /curl[^|\n]*\|\s*(sudo\s+)?(ba)?sh/, `${file} pipes a download into a shell`);
    assert.doesNotMatch(source, /eval\s/, `${file} uses eval`);
    assert.doesNotMatch(source, /\|\s*grep\s+-[A-Za-z]*q/, `${file} pipes into grep -q, which breaks under pipefail`);
    assert.doesNotMatch(source, /docker\.sock/, `${file} touches the docker socket`);
    execFileSync('bash', ['-n', path.join(REPOSITORY_ROOT, file)]);
  }
});
