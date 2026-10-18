import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import { TERMINAL_STATES } from './db/database.js';
import {
  ADAPTIVE_DENSITIES,
  LEGACY_DENSITIES,
  prepareImage,
  renderPreviews
} from './icons/iconGenerator.js';
import { resolveInside, safeFileStem } from './security/paths.js';
import { toPublicBuild } from './serializers.js';
import { buildIdPattern, clientTokenPattern, iconSettingsSchema, listQuerySchema } from './validation/schemas.js';

const VERSION = '0.1.0';
const HEARTBEAT_MILLISECONDS = 15000;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const safeEqual = (left, right) => {
  const a = Buffer.from(sha256(left), 'hex');
  const b = Buffer.from(sha256(right), 'hex');
  return timingSafeEqual(a, b);
};

const asyncRoute = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

const parseJsonField = (value) => {
  if (value === undefined || value === '') return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(422, 'invalid_json', 'The settings field must contain valid JSON.');
  }
};

const toDataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;

export function createApp({ config, database, queue, events, logger, buildService }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    next();
  });

  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Token, Last-Event-ID');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Expose-Headers', 'X-Artifact-Sha256, Content-Disposition');
    }
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '100kb' }));

  const router = express.Router();

  router.get('/health', (request, response) => {
    response.json({ status: 'ok', version: VERSION, uptimeSeconds: Math.round(process.uptime()) });
  });

  router.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (request, response, next) => next(new AppError(429, 'rate_limited', 'Too many requests. Please slow down.'))
    })
  );

  router.use((request, response, next) => {
    if (config.apiKey) {
      const header = request.get('authorization') ?? '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!provided || !safeEqual(provided, config.apiKey)) {
        throw new AppError(401, 'unauthorized', 'A valid API key is required.');
      }
    }
    next();
  });

  router.get('/config', (request, response) => {
    response.json({
      limits: {
        maxUploadBytes: config.limits.maxUploadBytes,
        maxExtractedBytes: config.limits.maxExtractedBytes,
        maxHtmlBytes: config.limits.maxHtmlBytes,
        maxImageBytes: config.limits.maxImageBytes,
        maxImagePixels: config.limits.maxImagePixels,
        maxZipFiles: config.limits.maxZipFiles,
        maxStorageBytesPerClient: config.limits.maxStorageBytesPerClient,
        maxActiveBuildsPerClient: config.limits.maxActiveBuildsPerClient
      },
      queue: { maxQueued: config.queue.maxQueued, concurrency: config.queue.concurrency },
      retentionHours: config.retentionHours,
      icon: { legacyDensities: LEGACY_DENSITIES, adaptiveDensities: ADAPTIVE_DENSITIES },
      signingModes: ['debug'],
      authenticationRequired: Boolean(config.apiKey)
    });
  });

  const identify = (request, response, next) => {
    const token = request.get('x-client-token') ?? '';
    if (!clientTokenPattern.test(token)) {
      throw new AppError(401, 'client_token_required', 'A valid X-Client-Token header is required.');
    }
    request.ownerHash = sha256(token);
    next();
  };

  const iconUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.limits.maxImageBytes, files: 1, fields: 5, parts: 8 }
  });

  router.post(
    '/icons/preview',
    iconUpload.single('icon'),
    asyncRoute(async (request, response) => {
      if (!request.file) {
        throw new AppError(422, 'missing_icon', 'An image file is required in the "icon" field.');
      }
      const settings = iconSettingsSchema.parse(parseJsonField(request.body.settings));
      const { working, info } = await prepareImage(request.file.buffer, {
        maxBytes: config.limits.maxImageBytes,
        maxPixels: config.limits.maxImagePixels
      });
      const previews = await renderPreviews(working, settings);
      response.json({
        source: info,
        previews: Object.fromEntries(Object.entries(previews).map(([name, buffer]) => [name, toDataUrl(buffer)]))
      });
    })
  );

  const requireOwned = (request) => {
    const build = database.getBuild(request.params.id);
    if (!build || build.ownerHash !== request.ownerHash) {
      throw new AppError(404, 'build_not_found', 'Build not found.');
    }
    return build;
  };

  router.param('id', (request, response, next, value) => {
    if (!buildIdPattern.test(value)) {
      next(new AppError(404, 'build_not_found', 'Build not found.'));
      return;
    }
    next();
  });

  const buildUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.limits.maxUploadBytes, files: 2, fields: 5, parts: 10 }
  }).fields([
    { name: 'source', maxCount: 1 },
    { name: 'icon', maxCount: 1 }
  ]);

  const buildCreationLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: Math.max(5, Math.floor(config.rateLimit.limit / 6)),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (request, response, next) => next(new AppError(429, 'rate_limited', 'Too many build requests. Please slow down.'))
  });

  router.post(
    '/builds',
    identify,
    buildCreationLimiter,
    buildUpload,
    asyncRoute(async (request, response) => {
      const build = await buildService.submit({
        ownerHash: request.ownerHash,
        rawConfig: parseJsonField(request.body.config),
        source: request.files?.source?.[0]?.buffer ?? null,
        icon: request.files?.icon?.[0]?.buffer ?? null
      });
      response.status(202).location(`/api/builds/${build.id}`).json({ build });
    })
  );

  router.get('/builds', identify, (request, response) => {
    const { limit, offset } = listQuerySchema.parse(request.query);
    const builds = database.listBuilds(request.ownerHash, { limit, offset });
    response.json({
      builds: builds.map((build) => toPublicBuild(build, queue.position(build.id))),
      stats: database.stats(request.ownerHash),
      storageUsedBytes: database.storageUsedBytes(request.ownerHash)
    });
  });

  router.get('/builds/:id', identify, (request, response) => {
    const build = requireOwned(request);
    response.json({ build: toPublicBuild(build, queue.position(build.id)) });
  });

  router.get(
    '/builds/:id/events',
    identify,
    asyncRoute(async (request, response) => {
      const build = requireOwned(request);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const send = (event, data, id) => {
        if (id !== undefined) response.write(`id: ${id}\n`);
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const lastEventId = Number.parseInt(request.get('last-event-id') ?? '0', 10) || 0;
      send('state', toPublicBuild(build, queue.position(build.id)));
      for (const log of database.getLogs(build.id, lastEventId)) {
        send('log', { line: log.line, at: log.createdAt }, log.seq);
      }
      if (TERMINAL_STATES.has(build.state)) {
        send('end', { state: build.state });
        response.end();
        return;
      }
      let closed = false;
      let unsubscribe = () => {};
      const heartbeat = setInterval(() => send('heartbeat', {}), HEARTBEAT_MILLISECONDS);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      unsubscribe = events.subscribe(build.id, (event) => {
        send(event.type, event.data, event.seq);
        if (event.type === 'end') {
          close();
          response.end();
        }
      });
      request.on('close', close);
    })
  );

  router.post(
    '/builds/:id/cancel',
    identify,
    asyncRoute(async (request, response) => {
      const build = requireOwned(request);
      if (TERMINAL_STATES.has(build.state)) {
        throw new AppError(409, 'build_finished', 'The build has already finished.');
      }
      const outcome = queue.cancel(build.id);
      if (outcome !== 'aborted') {
        const updated = database.transition(build.id, 'cancelled', { stage: 'cancelled' });
        events.publish(build.id, { type: 'end', data: { state: 'cancelled' } });
        response.json({ build: toPublicBuild(updated) });
        return;
      }
      response.status(202).json({ build: toPublicBuild(build), message: 'Cancellation requested.' });
    })
  );

  router.get(
    '/builds/:id/download',
    identify,
    asyncRoute(async (request, response) => {
      const build = requireOwned(request);
      if (build.state !== 'completed' || !build.artifactName) {
        throw new AppError(409, 'artifact_unavailable', 'The build has no downloadable artifact.');
      }
      if (build.expiresAt && Date.parse(build.expiresAt) <= Date.now()) {
        throw new AppError(410, 'artifact_expired', 'The artifact has expired.');
      }
      const file = resolveInside(config.artifactDirectory, build.artifactName);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat) throw new AppError(410, 'artifact_missing', 'The artifact is no longer available.');
      const filename = `${safeFileStem(build.appName)}-${build.signingMode}.apk`;
      response.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Artifact-Sha256': build.artifactSha256
      });
      await pipeline(fs.createReadStream(file), response);
    })
  );

  router.delete(
    '/builds/:id',
    identify,
    asyncRoute(async (request, response) => {
      const build = requireOwned(request);
      if (!TERMINAL_STATES.has(build.state)) {
        throw new AppError(409, 'build_active', 'Cancel the build before deleting it.');
      }
      if (build.artifactName) {
        await fs.promises.rm(resolveInside(config.artifactDirectory, build.artifactName), { force: true });
      }
      database.deleteBuild(build.id);
      response.status(204).end();
    })
  );

  router.use((request, response, next) => {
    next(new AppError(404, 'not_found', 'Endpoint not found.'));
  });

  app.use('/api', router);

  const frontendDirectory = path.resolve(import.meta.dirname, '../../frontend');
  if (fs.existsSync(path.join(frontendDirectory, 'index.html'))) {
    app.use(
      express.static(frontendDirectory, {
        index: 'index.html',
        maxAge: '1h',
        setHeaders: (response) => {
          response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
        }
      })
    );
  }

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof AppError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof ZodError) {
      response.status(422).json({
        error: {
          code: 'validation_failed',
          message: 'The request is not valid.',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
        }
      });
      return;
    }
    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      response.status(status).json({ error: { code: 'upload_rejected', message: 'The upload was rejected.' } });
      return;
    }
    if (error && error.type === 'entity.parse.failed') {
      response.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON.' } });
      return;
    }
    logger.error({ err: error }, 'unhandled error');
    response.status(500).json({ error: { code: 'internal_error', message: 'An unexpected error occurred.' } });
  });

  return app;
}
