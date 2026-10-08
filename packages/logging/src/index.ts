import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      '*.password',
      '*.apiKey',
      '*.token',
      'config.OPENAI_API_KEY',
      'config.EMAIL_PROVIDER_API_KEY',
    ],
    censor: '[REDACTED]',
  },
});
