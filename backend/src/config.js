import path from 'node:path';

const BYTES_PER_MEGABYTE = 1024 * 1024;

const parseInteger = (value, fallback, minimum, maximum, name) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid configuration for ${name}: expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
};

const parseList = (value) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  const environment = env.NODE_ENV ?? 'development';
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? '';
  if (environment === 'production') {
    if (!publicBaseUrl) {
      throw new Error('PUBLIC_BASE_URL is required in production.');
    }
    if (!publicBaseUrl.startsWith('https://')) {
      throw new Error('PUBLIC_BASE_URL must use https in production.');
    }
  }
  const dataDirectory = path.resolve(env.DATA_DIR ?? './data');
  const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
  for (const origin of allowedOrigins) {
    try {
      new URL(origin);
    } catch {
      throw new Error(`Invalid origin in ALLOWED_ORIGINS: ${origin}`);
    }
  }
  const gradleJvmArgs = env.GRADLE_JVM_ARGS ?? '-Xmx2g';
  if (!/^[-A-Za-z0-9=:.\s]+$/.test(gradleJvmArgs)) {
    throw new Error('GRADLE_JVM_ARGS contains unsupported characters.');
  }
  const maxUploadMegabytes = parseInteger(env.MAX_UPLOAD_MB, 50, 1, 500, 'MAX_UPLOAD_MB');
  const maxImageMegabytes = parseInteger(env.MAX_IMAGE_MB, 10, 1, 50, 'MAX_IMAGE_MB');
  const maxHtmlMegabytes = parseInteger(env.MAX_HTML_MB, 5, 1, 50, 'MAX_HTML_MB');
  return Object.freeze({
    environment,
    port: parseInteger(env.PORT, 3000, 1, 65535, 'PORT'),
    publicBaseUrl,
    trustProxy: env.TRUST_PROXY === 'true',
    apiKey: env.API_KEY ? env.API_KEY : null,
    databaseFile: path.resolve(env.DATABASE_FILE ?? path.join(dataDirectory, 'metadata.sqlite')),
    artifactDirectory: path.resolve(env.ARTIFACT_DIR ?? path.join(dataDirectory, 'artifacts')),
    workspaceDirectory: path.resolve(env.WORKSPACE_DIR ?? path.join(dataDirectory, 'workspaces')),
    androidHome: env.ANDROID_HOME ? path.resolve(env.ANDROID_HOME) : null,
    gradleCommand: env.GRADLE_COMMAND ?? 'gradle',
    gradleUserHome: path.resolve(env.GRADLE_USER_HOME ?? path.join(dataDirectory, 'gradle-home')),
    buildHomeDirectory: path.resolve(env.BUILD_HOME_DIR ?? path.join(dataDirectory, 'build-home')),
    gradleJvmArgs,
    limits: Object.freeze({
      maxUploadBytes: maxUploadMegabytes * BYTES_PER_MEGABYTE,
      maxExtractedBytes: parseInteger(env.MAX_EXTRACTED_MB, 150, 1, 2000, 'MAX_EXTRACTED_MB') * BYTES_PER_MEGABYTE,
      maxZipFiles: parseInteger(env.MAX_ZIP_FILES, 2000, 1, 50000, 'MAX_ZIP_FILES'),
      maxZipDepth: parseInteger(env.MAX_ZIP_DEPTH, 12, 1, 64, 'MAX_ZIP_DEPTH'),
      maxHtmlBytes: maxHtmlMegabytes * BYTES_PER_MEGABYTE,
      maxImageBytes: maxImageMegabytes * BYTES_PER_MEGABYTE,
      maxImagePixels: parseInteger(env.MAX_IMAGE_PIXELS, 25000000, 1000, 200000000, 'MAX_IMAGE_PIXELS'),
      maxActiveBuildsPerClient: parseInteger(env.MAX_ACTIVE_BUILDS_PER_CLIENT, 3, 1, 50, 'MAX_ACTIVE_BUILDS_PER_CLIENT'),
      maxStorageBytesPerClient:
        parseInteger(env.MAX_STORAGE_MB_PER_CLIENT, 500, 1, 100000, 'MAX_STORAGE_MB_PER_CLIENT') * BYTES_PER_MEGABYTE
    }),
    queue: Object.freeze({
      maxQueued: parseInteger(env.QUEUE_LIMIT, 20, 1, 1000, 'QUEUE_LIMIT'),
      concurrency: parseInteger(env.WORKER_CONCURRENCY, 1, 1, 32, 'WORKER_CONCURRENCY'),
      buildTimeoutMs: parseInteger(env.BUILD_TIMEOUT_SECONDS, 900, 30, 7200, 'BUILD_TIMEOUT_SECONDS') * 1000
    }),
    retentionHours: parseInteger(env.ARTIFACT_RETENTION_HOURS, 72, 1, 8760, 'ARTIFACT_RETENTION_HOURS'),
    allowedOrigins,
    rateLimit: Object.freeze({
      windowMs: parseInteger(env.RATE_LIMIT_WINDOW_SECONDS, 60, 1, 3600, 'RATE_LIMIT_WINDOW_SECONDS') * 1000,
      limit: parseInteger(env.RATE_LIMIT_MAX, 120, 1, 100000, 'RATE_LIMIT_MAX')
    })
  });
}
