import pino from 'pino';

const isK8s = process.env.K8S_ENV === 'true';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isK8s
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
