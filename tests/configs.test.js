import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFile(path.join(ROOT, file), 'utf8');

const yaml = (file) =>
  JSON.parse(execFileSync('python3', ['-c', 'import yaml, json, sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path.join(ROOT, file)], { encoding: 'utf8' }));

const toml = (file) =>
  JSON.parse(execFileSync('python3', ['-c', 'import tomllib, json, sys; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', path.join(ROOT, file)], { encoding: 'utf8' }));

test('docker compose runs the app unprivileged, limited and without the docker socket', async () => {
  const compose = yaml('docker-compose.yml');
  const app = compose.services.app;
  assert.equal(app.user, '10001:10001');
  assert.deepEqual(app.cap_drop, ['ALL']);
  assert.ok(app.security_opt.includes('no-new-privileges:true'));
  assert.ok(app.pids_limit > 0);
  assert.ok(app.mem_limit);
  assert.ok(app.cpus);
  assert.ok(app.ports[0].startsWith('${BIND_ADDRESS:-127.0.0.1}'));
  assert.ok(app.volumes.some((volume) => volume.endsWith(':/data')));
  assert.equal(app.environment.DATA_DIR, '/data');
  assert.ok(!JSON.stringify(compose).includes('docker.sock'));
  assert.deepEqual(compose.services.caddy.profiles, ['https']);
  assert.equal(compose.services.caddy.depends_on.app.condition, 'service_healthy');
  assert.deepEqual(compose.services.caddy.cap_add, ['NET_BIND_SERVICE']);
  assert.ok(compose.services.caddy.volumes.includes('./Caddyfile:/etc/caddy/Caddyfile:ro'));
});

test('every variable interpolated by compose is documented in .env.example', async () => {
  const compose = await read('docker-compose.yml');
  const example = await read('.env.example');
  const documented = new Set(example.split('\n').map((line) => line.split('=')[0]).filter(Boolean));
  const used = [...compose.matchAll(/\$\{([A-Z_]+)(?::-[^}]*)?\}/g)].map((match) => match[1]);
  assert.ok(used.length >= 6);
  for (const name of new Set(used)) assert.ok(documented.has(name), `${name} missing from .env.example`);
});

test('every environment variable read by the application is documented in .env.example', async () => {
  const configuration = await read('backend/src/config.js');
  const example = await read('.env.example');
  const documented = new Set(example.split('\n').map((line) => line.split('=')[0]).filter(Boolean));
  const used = [...configuration.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]).filter((name) => name !== 'NODE_ENV' || true);
  assert.ok(used.length > 20);
  for (const name of new Set(used)) assert.ok(documented.has(name), `${name} missing from .env.example`);
  assert.doesNotMatch(example, /(password|secret|token)=\S+/i);
});

test('the Dockerfile uses a pinned base, a non-root user, a health check and no latest tags', async () => {
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m);
  assert.doesNotMatch(dockerfile, /:latest/);
  assert.match(dockerfile, /^USER builder$/m);
  assert.ok(dockerfile.indexOf('USER builder') > dockerfile.indexOf('useradd'));
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /--uid 10001/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.doesNotMatch(dockerfile, /curl[^\n]*\|\s*(ba)?sh/);
  assert.match(dockerfile, /GRADLE_SHA256/);
  const ignore = await read('.dockerignore');
  for (const entry of ['node_modules', '.env', 'data', '.git']) assert.ok(ignore.split('\n').includes(entry), entry);
});

test('the toolchain installer verifies checksums when supplied and rejects mismatches', async () => {
  const source = await read('scripts/docker/install-toolchain.sh');
  assert.match(source, /sha256sum --check/);
  assert.match(source, /Checksum mismatch/);
  assert.doesNotMatch(source, /\|\s*(ba)?sh\b/);
});

test('render, railway, fly, netlify and vercel configurations match the architecture', async () => {
  const render = yaml('render.yaml').services[0];
  assert.equal(render.runtime, 'docker');
  assert.equal(render.healthCheckPath, '/api/health');
  assert.equal(render.disk.mountPath, '/data');
  assert.equal(render.autoDeploy, false);
  assert.ok(render.envVars.some((entry) => entry.key === 'PUBLIC_BASE_URL' && entry.sync === false));
  assert.ok(render.envVars.some((entry) => entry.key === 'DATA_DIR' && entry.value === '/data'));
  assert.ok(!render.envVars.some((entry) => /KEY|SECRET|PASSWORD/.test(entry.key) && entry.value));
  const railway = JSON.parse(await read('railway.json'));
  assert.equal(railway.build.builder, 'DOCKERFILE');
  assert.equal(railway.deploy.healthcheckPath, '/api/health');
  const fly = toml('fly.toml');
  assert.equal(fly.mounts[0].destination, '/data');
  assert.equal(fly.http_service.internal_port, 3000);
  assert.equal(fly.http_service.force_https, true);
  assert.equal(fly.http_service.checks[0].path, '/api/health');
  assert.equal(fly.env.DATA_DIR, '/data');
  assert.ok(Number.parseInt(fly.vm[0].memory, 10) >= 4);
  const netlify = toml('netlify.toml');
  assert.equal(netlify.build.publish, 'frontend');
  assert.match(netlify.build.command, /write-frontend-config/);
  const vercel = JSON.parse(await read('vercel.json'));
  assert.equal(vercel.outputDirectory, 'frontend');
  const policies = [netlify.headers[0].values['Content-Security-Policy'], vercel.headers[0].headers.find((header) => header.key === 'Content-Security-Policy').value];
  for (const policy of policies) {
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  }
});

test('workflows pin permissions, avoid auto-deployment and cover every quality gate', async () => {
  const ci = yaml('.github/workflows/ci.yml');
  assert.deepEqual(ci.permissions, { contents: 'read' });
  for (const job of ['unit-tests', 'browser-tests', 'shell-scripts', 'docker', 'dependency-audit', 'android-template']) assert.ok(ci.jobs[job], job);
  const release = yaml('.github/workflows/release.yml');
  assert.deepEqual(Object.keys((release.on ?? release.true).push), ['tags']);
  assert.ok(release.jobs.package.needs === 'verify' && release.jobs.image.needs === 'verify');
  const text = (await read('.github/workflows/ci.yml')) + (await read('.github/workflows/release.yml'));
  for (const reference of text.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) assert.match(reference[2], /^v\d+$/, `${reference[1]} is not pinned to a major version`);
  assert.doesNotMatch(text, /(ssh|scp|kubectl|helm|flyctl|railway|vercel) /i);
});

test('the frontend config writer validates the api address', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-'));
  const output = path.join(directory, 'config.js');
  const run = (apiBase) => spawnSync('node', [path.join(ROOT, 'scripts/write-frontend-config.mjs'), output], { env: { ...process.env, API_BASE: apiBase }, encoding: 'utf8' });
  assert.equal(run('https://api.example.com/').status, 0);
  assert.equal(await fs.readFile(output, 'utf8'), 'window.INCONNU_CONFIG = { apiBase: "https://api.example.com" };\n');
  assert.equal(run('').status, 0);
  assert.equal(await fs.readFile(output, 'utf8'), 'window.INCONNU_CONFIG = { apiBase: "" };\n');
  assert.notEqual(run('ftp://example.com').status, 0);
  assert.notEqual(run('not a url').status, 0);
  const injected = run('https://example.com/";alert(1);//');
  assert.ok(!(await fs.readFile(output, 'utf8')).includes('alert(1);//"'));
  assert.equal(injected.status, 0);
  await fs.rm(directory, { recursive: true });
});

test('the sample project generator produces a project that the CI job can compile', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-'));
  const result = spawnSync('node', [path.join(ROOT, 'scripts/prepare-sample-project.mjs'), directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const argumentsFile = (await fs.readFile(path.join(directory, 'gradle-arguments.txt'), 'utf8')).trim().split('\n');
  assert.ok(argumentsFile.includes('-Pinconnu.applicationId=dev.inconnuboy.sample'));
  await fs.access(path.join(directory, 'project/app/src/main/assets/www/index.html'));
  await fs.access(path.join(directory, 'project/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'));
  await fs.rm(directory, { recursive: true });
});

const COMMENT_RULES = [
  { extensions: ['.js', '.mjs', '.kt', '.kts'], pattern: /^\s*(\/\/|\/\*)/m },
  { extensions: ['.css'], pattern: /\/\*/ },
  { extensions: ['.html', '.xml', '.svg'], pattern: /<!--/ },
  { extensions: ['.sh', '.yml', '.yaml', '.toml', '.properties', '.pro', ''], pattern: /^\s*#(?!!)/m }
];

async function* walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'docs', 'data'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

test('no source or configuration file contains comments', async () => {
  const offenders = [];
  let scanned = 0;
  for await (const file of walk(ROOT)) {
    const name = path.basename(file);
    const extension = path.extname(file);
    if (['.md', '.png', '.json', '.zip', '.lock'].includes(extension) || name === 'LICENSE' || name === 'Caddyfile') continue;
    const bare = ['Dockerfile', 'Makefile', '.gitignore', '.dockerignore', '.env.example'].includes(name);
    const rule = COMMENT_RULES.find((candidate) => candidate.extensions.includes(bare ? '' : extension));
    if (!rule) continue;
    scanned += 1;
    if (rule.pattern.test(await fs.readFile(file, 'utf8'))) offenders.push(path.relative(ROOT, file));
  }
  assert.ok(scanned > 80, `only ${scanned} files scanned`);
  assert.deepEqual(offenders, []);
});

test('documentation only references scripts and files that exist', async () => {
  const documents = ['README.md', ...(await fs.readdir(path.join(ROOT, 'docs/deployment'))).map((name) => `docs/deployment/${name}`)];
  const missing = [];
  let references = 0;
  for (const document of documents) {
    const text = await read(document);
    for (const match of text.matchAll(/scripts\/([a-z-]+\.(?:sh|mjs))/g)) {
      references += 1;
      if (!(await fs.access(path.join(ROOT, 'scripts', match[1])).then(() => true, () => false))) missing.push(`${document}: scripts/${match[1]}`);
    }
    for (const match of text.matchAll(/`(\w[\w-]*\.md)`/g)) {
      if (document.startsWith('docs/deployment/') && !(await fs.access(path.join(ROOT, 'docs/deployment', match[1])).then(() => true, () => false))) missing.push(`${document}: ${match[1]}`);
    }
  }
  assert.ok(references >= 8);
  assert.deepEqual(missing, []);
  const overview = await read('docs/deployment/README.md');
  for (const provider of ['Railway', 'Render', 'Fly.io', 'DigitalOcean', 'Hetzner', 'Oracle', 'AWS', 'Google Cloud', 'Azure', 'Vercel']) assert.ok(overview.includes(provider), provider);
  assert.match(overview, /ARM/);
});

test('the content security policy served with the frontend allows no remote connections', async () => {
  const source = await read('backend/src/app.js');
  const policy = /const CONTENT_SECURITY_POLICY = \[([\s\S]*?)\]\.join/.exec(source)[1];
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /connect-src 'self'"/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https:|http:/);
});

test('dependencies are pinned exactly and the test script prints a readable failure summary', async () => {
  const manifest = JSON.parse(await read('package.json'));
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is not pinned exactly`);
  }
  assert.match(manifest.scripts.test, /--test-reporter=spec/);
});
