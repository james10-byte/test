import fs from 'node:fs';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { createBuildEvents } from './events.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';
import { createBuildRunner } from './build/buildRunner.js';
import { createBuildService } from './build/buildService.js';
import { BuildQueue } from './queue/buildQueue.js';
import { startCleanupSchedule } from './storage/cleanup.js';

const WORKSPACE_MAX_AGE_MS = 6 * 3600 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const config = loadConfig();
const logger = createLogger(config);

fs.mkdirSync(config.artifactDirectory, { recursive: true });
fs.mkdirSync(config.workspaceDirectory, { recursive: true });

const database = createDatabase(config.databaseFile, { retentionHours: config.retentionHours });
const recovered = database.recoverInterrupted();
if (recovered > 0) logger.warn({ recovered }, 'interrupted builds marked as failed');

const events = createBuildEvents();

const runner = createBuildRunner({ config, database, events, logger });

const queue = new BuildQueue({
  concurrency: config.queue.concurrency,
  maxQueued: config.queue.maxQueued,
  timeoutMs: config.queue.buildTimeoutMs,
  runner,
  onError: (id, error) => logger.error({ err: error, buildId: id }, 'build runner error')
});

const buildService = createBuildService({ config, database, queue });

const app = createApp({ config, database, queue, events, logger, buildService });

const stopCleanup = startCleanupSchedule({
  database,
  artifactDirectory: config.artifactDirectory,
  workspaceDirectory: config.workspaceDirectory,
  intervalMs: CLEANUP_INTERVAL_MS,
  workspaceMaxAgeMs: WORKSPACE_MAX_AGE_MS,
  logger
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'INCONNU BOY APK BUILDER listening');
});

const shutdown = () => {
  stopCleanup();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
