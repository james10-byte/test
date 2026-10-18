import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');

const DOCKER_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, 'docker ' + args.join(' ') + '\\n');
if (args[0] === 'info') process.exit(0);
if (args[0] !== 'compose') process.exit(0);
let rest = args.slice(1);
while (rest[0] === '--project-directory' || rest[0] === '--profile') rest = rest.slice(2);
const command = rest[0];
if (command === 'version') {
  console.log('Docker Compose version v2.stub');
  process.exit(0);
}
const flag = path.join(process.env.STUB_STATE, 'fail-' + command);
if (fs.existsSync(flag)) {
  fs.rmSync(flag);
  console.error('stub: ' + command + ' failed');
  process.exit(1);
}
if (command === 'ps') {
  console.log(process.env.STUB_PS || 'app running healthy');
  process.exit(0);
}
if (command === 'logs') {
  console.log('stub application log');
  process.exit(0);
}
if (command === 'exec' || command === 'run') {
  const nodeIndex = rest.indexOf('node');
  if (nodeIndex === -1) process.exit(0);
  const mapping = [['/data', process.env.STUB_DATA]];
  const volume = rest.indexOf('-v');
  if (command === 'run' && volume !== -1) {
    const parts = rest[volume + 1].split(':');
    mapping.push([parts[1], parts[0]]);
  }
  const translate = (value) => {
    for (const [from, to] of mapping) if (value.startsWith(from)) return to + value.slice(from.length);
    return value;
  };
  const script = path.join(process.env.INSTALL_DIR, rest[nodeIndex + 1]);
  const result = spawnSync('node', [script, ...rest.slice(nodeIndex + 2).map(translate)], { stdio: 'inherit' });
  process.exit(result.status === null ? 1 : result.status);
}
process.exit(0);
`;

const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
for argument in "$@"; do
  case "$argument" in
    *"/api/health"*)
      if [ -f "$STUB_STATE/unhealthy" ]; then exit 22; fi
      echo '{"status":"ok"}'
      exit 0 ;;
  esac
done
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then output="$2"; fi
  shift
done
if [ -n "$output" ] && [ "$output" != "/dev/null" ]; then echo stub > "$output"; fi
exit 0
`;

const GENERIC_STUB = `#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$STUB_LOG"
exit 0
`;

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });

export async function createSandbox({ osRelease = 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-'));
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'origin.git');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  const installDirectory = path.join(root, 'install');
  const backupDirectory = path.join(root, 'backups');
  const osReleaseFile = path.join(root, 'os-release');
  await fs.mkdir(seed, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(osReleaseFile, osRelease);
  for (const entry of ['docker-compose.yml', '.env.example', '.gitignore', 'Caddyfile']) {
    await fs.copyFile(path.join(REPOSITORY_ROOT, entry), path.join(seed, entry));
  }
  await fs.cp(path.join(REPOSITORY_ROOT, 'scripts'), path.join(seed, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(seed, 'VERSION'), 'one\n');
  git(seed, 'init', '--quiet');
  git(seed, 'add', '--all');
  git(seed, 'commit', '--quiet', '-m', 'initial');
  git(root, 'clone', '--quiet', '--bare', seed, origin);

  await fs.writeFile(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  for (const name of ['apt-get', 'systemctl']) await fs.writeFile(path.join(bin, name), GENERIC_STUB, { mode: 0o755 });

  const log = path.join(root, 'calls.log');
  await fs.writeFile(log, '');
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: log,
    STUB_STATE: state,
    STUB_DATA: path.join(installDirectory, 'data'),
    INSTALL_DIR: installDirectory,
    BACKUP_DIR: backupDirectory,
    OS_RELEASE_FILE: osReleaseFile,
    REPO_URL: `file://${origin}`,
    MIN_MEMORY_MB: '1',
    MIN_DISK_MB: '1',
    HEALTH_TIMEOUT: '6',
    HEALTH_INTERVAL: '1',
    NO_COLOR: '1',
    INCONNU_SKIP_ROOT_CHECK: '1',
    INCONNU_ALLOW_ARM: '1'
  };

  return {
    root,
    installDirectory,
    backupDirectory,
    state,
    origin,
    log,
    environment,
    run(script, args = [], extraEnvironment = {}) {
      const result = spawnSync('bash', [script, ...args], { env: { ...environment, ...extraEnvironment }, encoding: 'utf8', input: '', timeout: 120000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
    },
    install(args = [], extraEnvironment = {}) {
      return this.run(path.join(REPOSITORY_ROOT, 'install.sh'), args, extraEnvironment);
    },
    script(name, args = [], extraEnvironment = {}) {
      return this.run(path.join(installDirectory, 'scripts', name), args, extraEnvironment);
    },
    async calls() {
      return (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean);
    },
    async clearCalls() {
      await fs.writeFile(log, '');
    },
    async pushCommit(files, message = 'update') {
      const work = await fs.mkdtemp(path.join(root, 'work-'));
      git(root, 'clone', '--quiet', origin, work);
      for (const [name, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(work, name)), { recursive: true });
        await fs.writeFile(path.join(work, name), content);
      }
      git(work, 'add', '--all');
      git(work, 'commit', '--quiet', '-m', message);
      git(work, 'push', '--quiet', 'origin', 'main');
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

export { git };
