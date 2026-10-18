import pino from 'pino';

export function createLogger(config) {
  return pino({
    level: config.environment === 'test' ? 'silent' : 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-client-token"]',
        '*.password',
        '*.keystorePassword',
        '*.keyPassword',
        '*.apiKey'
      ],
      censor: '[redacted]'
    }
  });
}
