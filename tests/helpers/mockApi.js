import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';

const FRONTEND = path.resolve(import.meta.dirname, '../../frontend');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const STEP_MS = 120;

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? '');
  if (!boundary) return {};
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const fields = {};
  let start = buffer.indexOf(delimiter);
  while (start !== -1) {
    const next = buffer.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = buffer.subarray(start + delimiter.length + 2, next - 2);
    const separator = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, separator).toString('utf8');
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (name) fields[name] = { filename, data: part.subarray(separator + 4) };
    start = next;
  }
  return fields;
}

export async function startMockApi({ stepMs = STEP_MS, requireApiKey = null } = {}) {
  const builds = new Map();
  const subscribers = new Map();
  const apkPayload = randomBytes(2048);
  const apkHash = createHash('sha256').update(apkPayload).digest('hex');
  const previewImage = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 60, g: 110, b: 240, alpha: 1 } } }).png().toBuffer();
  const previewUrl = `data:image/png;base64,${previewImage.toString('base64')}`;
  const log = [];

  const publicBuild = (build) => ({
    id: build.id,
    appName: build.appName,
    inputType: build.inputType,
    state: build.state,
    stage: build.state,
    errorSummary: build.errorSummary ?? null,
    signingMode: 'debug',
    config: build.config,
    artifact: build.state === 'completed' ? { size: apkPayload.length, sha256: apkHash } : null,
    queuePosition: null,
    createdAt: build.createdAt,
    updatedAt: new Date().toISOString(),
    expiresAt: build.state === 'completed' ? new Date(Date.now() + 72 * 3600 * 1000).toISOString() : null
  });

  const emit = (id, type, data, seq) => {
    for (const response of subscribers.get(id) ?? []) {
      if (seq !== undefined) response.write(`id: ${seq}\n`);
      response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      if (type === 'end') response.end();
    }
  };

  const addLog = (build, line) => {
    build.logs.push(line);
    emit(build.id, 'log', { line, at: new Date().toISOString() }, build.logs.length);
  };

  const setState = (build, state, extra = {}) => {
    Object.assign(build, extra, { state });
    emit(build.id, 'state', publicBuild(build));
  };

  const finish = (build, state, extra) => {
    setState(build, state, extra);
    emit(build.id, 'end', { state });
  };

  const script = (build) => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    (async () => {
      await wait(stepMs);
      if (build.state !== 'queued') return;
      setState(build, 'preparing');
      addLog(build, 'Preparing the Android project.');
      await wait(stepMs);
      if (build.state !== 'preparing') return;
      setState(build, 'compiling');
      addLog(build, 'Starting Gradle.');
      if (build.appName.toLowerCase().includes('slow')) return;
      await wait(stepMs);
      addLog(build, '> Task :app:assembleDebug');
      await wait(stepMs);
      if (build.appName.toLowerCase().includes('fail')) {
        addLog(build, 'The Gradle build failed with exit code 1. Review the build log.');
        finish(build, 'failed', { errorSummary: 'The Gradle build failed with exit code 1. Review the build log.' });
        return;
      }
      setState(build, 'validating');
      await wait(stepMs);
      addLog(build, 'Build completed.');
      finish(build, 'completed');
    })();
  };

  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };

  const fail = (response, status, code, message, details) => json(response, status, { error: { code, message, details } });

  const readBody = (request) =>
    new Promise((resolve) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      try {
        const file = path.join(FRONTEND, path.normalize(relative));
        if (!file.startsWith(FRONTEND)) throw new Error('outside');
        const content = await fs.readFile(file);
        response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
        response.end(content);
      } catch {
        response.writeHead(404).end();
      }
      return;
    }
    log.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/api/health') return json(response, 200, { status: 'ok' });
    if (requireApiKey && request.headers.authorization !== `Bearer ${requireApiKey}`) return fail(response, 401, 'unauthorized', 'A valid API key is required.');
    const token = request.headers['x-client-token'] ?? '';
    if (url.pathname === '/api/config') {
      return json(response, 200, {
        limits: { maxUploadBytes: 5 * 1024 * 1024, maxHtmlBytes: 1024 * 1024, maxImageBytes: 2 * 1024 * 1024, maxStorageBytesPerClient: 500 * 1024 * 1024 },
        queue: { maxQueued: 20, concurrency: 1 },
        retentionHours: 72
      });
    }
    if (url.pathname === '/api/icons/preview' && request.method === 'POST') {
      await readBody(request);
      return json(response, 200, { source: { format: 'png', width: 64, height: 64 }, previews: { square: previewUrl, rounded: previewUrl, round: previewUrl, adaptive: previewUrl, transparency: previewUrl } });
    }
    if (!TOKEN.test(token)) return fail(response, 401, 'client_token_required', 'A valid X-Client-Token header is required.');
    const owned = [...builds.values()].filter((build) => build.owner === token);
    if (url.pathname === '/api/builds' && request.method === 'POST') {
      const fields = parseMultipart(await readBody(request), request.headers['content-type']);
      let config;
      try {
        config = JSON.parse(fields.config.data.toString('utf8'));
      } catch {
        return fail(response, 422, 'invalid_json', 'The settings field must contain valid JSON.');
      }
      if (config.inputType === 'zip' && fields.source && fields.source.data.length < 4) return fail(response, 422, 'ambiguous_entry_point', 'Several HTML files were found and none is named index.html.', { candidates: ['a.html', 'b.html'] });
      const id = randomBytes(16).toString('hex');
      const build = { id, owner: token, appName: config.appName, inputType: config.inputType, config: { ...config, warnings: [{ code: 'missing_local_resources', message: 'Some local resources are missing.', items: ['logo.png'] }] }, state: 'queued', logs: [], createdAt: new Date().toISOString() };
      builds.set(id, build);
      script(build);
      return json(response, 202, { build: publicBuild(build) }, { Location: `/api/builds/${id}` });
    }
    if (url.pathname === '/api/builds' && request.method === 'GET') {
      const sorted = owned.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const count = (state) => owned.filter((build) => build.state === state).length;
      return json(response, 200, {
        builds: sorted.slice(offset, offset + limit).map(publicBuild),
        stats: { total: owned.length, succeeded: count('completed'), failed: count('failed'), active: owned.filter((build) => ['queued', 'preparing', 'compiling', 'validating'].includes(build.state)).length },
        storageUsedBytes: count('completed') * apkPayload.length
      });
    }
    const match = /^\/api\/builds\/([a-f0-9]{32})(?:\/(events|cancel|download))?$/.exec(url.pathname);
    if (!match) return fail(response, 404, 'not_found', 'Endpoint not found.');
    const build = builds.get(match[1]);
    if (!build || build.owner !== token) return fail(response, 404, 'build_not_found', 'Build not found.');
    const action = match[2];
    if (!action && request.method === 'GET') return json(response, 200, { build: publicBuild(build) });
    if (!action && request.method === 'DELETE') {
      if (['queued', 'preparing', 'compiling', 'validating'].includes(build.state)) return fail(response, 409, 'build_active', 'Cancel the build before deleting it.');
      builds.delete(build.id);
      response.writeHead(204).end();
      return;
    }
    if (action === 'cancel') {
      if (!['queued', 'preparing', 'compiling', 'validating'].includes(build.state)) return fail(response, 409, 'build_finished', 'The build has already finished.');
      addLog(build, 'Build cancelled.');
      finish(build, 'cancelled');
      return json(response, 200, { build: publicBuild(build) });
    }
    if (action === 'download') {
      if (build.state !== 'completed') return fail(response, 409, 'artifact_unavailable', 'The build has no downloadable artifact.');
      response.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': apkPayload.length, 'Content-Disposition': 'attachment; filename="Demo-debug.apk"', 'X-Artifact-Sha256': apkHash });
      response.end(apkPayload);
      return;
    }
    if (action === 'events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const write = (type, data, seq) => {
        if (seq !== undefined) response.write(`id: ${seq}\n`);
        response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      write('state', publicBuild(build));
      const after = Number(request.headers['last-event-id'] ?? 0) || 0;
      build.logs.forEach((line, index) => {
        if (index + 1 > after) write('log', { line }, index + 1);
      });
      if (!['queued', 'preparing', 'compiling', 'validating'].includes(build.state)) {
        write('end', { state: build.state });
        response.end();
        return;
      }
      const set = subscribers.get(build.id) ?? new Set();
      set.add(response);
      subscribers.set(build.id, set);
      request.on('close', () => set.delete(response));
      return;
    }
    return fail(response, 405, 'method_not_allowed', 'Method not allowed.');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    builds,
    requests: log,
    apkSize: apkPayload.length,
    async close() {
      for (const set of subscribers.values()) for (const response of set) response.end();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
