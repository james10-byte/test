import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFile(path.join(ROOT, file), 'utf8');
const exists = (file) => fs.access(path.join(ROOT, file)).then(() => true, () => false);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
    else if (entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
}

async function markdownFiles() {
  const files = ['README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md', 'examples/api-usage.md'];
  for (const entry of await fs.readdir(path.join(ROOT, 'docs'), { recursive: true })) if (entry.endsWith('.md')) files.push(`docs/${entry}`);
  return files;
}

test('every file and directory the project promises exists and is not empty', async () => {
  const files = [
    'README.md', 'LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md', 'Dockerfile', 'docker-compose.yml',
    '.env.example', '.gitignore', 'Makefile', 'package.json', 'install.sh', 'railway.json', 'render.yaml', 'fly.toml',
    'docs/api.md', 'docs/architecture.md', 'docs/configuration.md', 'docs/security.md', 'docs/icons.md', 'docs/deployment/README.md'
  ];
  for (const file of files) assert.ok((await fs.stat(path.join(ROOT, file))).size > 100 || file === '.gitignore', `${file} is missing or empty`);
  for (const directory of ['frontend', 'backend', 'android-template', 'tests', 'docs', 'examples', 'scripts', '.github/workflows']) {
    assert.ok((await fs.readdir(path.join(ROOT, directory))).length > 0, `${directory} is empty`);
  }
  assert.equal(await exists('build-worker'), false);
  assert.match(await read('README.md'), /package-lock\.json/);
  assert.match(await read('docs/architecture.md'), /build-worker/);
});

test('every API route is documented with its method and path', async () => {
  const source = await read('backend/src/app.js');
  const documentation = await read('docs/api.md');
  const routes = [...source.matchAll(/router\.(get|post|delete)\(\s*'([^']+)'/g)].map((match) => `${match[1].toUpperCase()} /api${match[2]}`);
  assert.equal(routes.length, 10);
  for (const route of routes) assert.ok(documentation.includes(route), `${route} is not documented`);
});

test('every error code the backend can return is documented', async () => {
  const documentation = await read('docs/api.md');
  const codes = new Set();
  for (const file of await sourceFiles('backend/src')) {
    const source = await read(file);
    for (const match of source.matchAll(/AppError\(\s*\d+,\s*'([a-z_]+)'/g)) codes.add(match[1]);
    for (const match of source.matchAll(/\bfail\('([a-z_]+)'/g)) codes.add(match[1]);
  }
  for (const match of (await read('backend/src/app.js')).matchAll(/code: '([a-z_]+)'/g)) codes.add(match[1]);
  assert.ok(codes.size > 60, `only ${codes.size} codes found`);
  const missing = [...codes].filter((code) => !documentation.includes(`\`${code}\``));
  assert.deepEqual(missing, []);
});

test('the configuration reference lists every variable with the same default as .env.example', async () => {
  const example = new Map((await read('.env.example')).split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const documented = new Map();
  for (const match of (await read('docs/configuration.md')).matchAll(/^\| `([A-Z_]+)` \| `([^`]*)` \|/gm)) documented.set(match[1], match[2]);
  assert.ok(example.size > 30);
  for (const [name, value] of example) {
    assert.ok(documented.has(name), `${name} is not documented`);
    assert.equal(documented.get(name), value === '' ? 'empty' : value, `${name} default differs`);
  }
  for (const name of documented.keys()) assert.ok(example.has(name), `${name} is documented but unknown`);
});

test('documented npm scripts and make targets exist', async () => {
  const scripts = JSON.parse(await read('package.json')).scripts;
  const makefile = await read('Makefile');
  let checked = 0;
  for (const file of await markdownFiles()) {
    const text = await read(file);
    for (const match of text.matchAll(/npm run ([a-z:-]+)/g)) {
      checked += 1;
      assert.ok(scripts[match[1]], `${file}: npm run ${match[1]} does not exist`);
    }
    for (const match of text.matchAll(/\nmake ([a-z-]+)/g)) {
      checked += 1;
      assert.match(makefile, new RegExp(`^${match[1]}:`, 'm'), `${file}: make ${match[1]} does not exist`);
    }
  }
  assert.ok(checked >= 5);
});

test('relative links and images in the documentation resolve', async () => {
  const broken = [];
  let checked = 0;
  for (const file of await markdownFiles()) {
    const text = await read(file);
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (target === '' || /^(https?:|mailto:)/.test(target)) continue;
      checked += 1;
      if (!(await fs.access(path.join(ROOT, path.dirname(file), target)).then(() => true, () => false))) broken.push(`${file}: ${target}`);
    }
  }
  assert.ok(checked >= 4);
  assert.deepEqual(broken, []);
});

test('the documentation never claims what was not verified', async () => {
  const readme = await read('README.md');
  assert.match(readme, /unverified/i);
  assert.match(readme, /What was not verified/);
  for (const text of [readme, await read('CHANGELOG.md'), await read('docs/deployment/README.md')]) {
    assert.doesNotMatch(text, /production[- ]ready|fully tested|battle[- ]tested|guaranteed/i);
  }
  const changelog = await read('CHANGELOG.md');
  assert.match(changelog, /No real Gradle build/);
});

test('the creator and product identity are stated consistently', async () => {
  for (const file of ['README.md', 'frontend/index.html', 'LICENSE']) {
    assert.match(await read(file), /INCONNU BOY/);
  }
  assert.match(await read('README.md'), /INCONNU BOY SENSEI/);
  assert.match(await read('frontend/js/views/about.js'), /INCONNU BOY SENSEI/);
  assert.match(await read('LICENSE'), /^MIT License/);
});
