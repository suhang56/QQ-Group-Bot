import pino from 'pino';

export type Logger = pino.Logger;

let rootLogger: pino.Logger | null = null;

export function initLogger(options?: pino.LoggerOptions & { transport?: pino.TransportSingleOptions }): void {
  const level = process.env['LOG_LEVEL'] ?? 'info';
  rootLogger = pino({ level, ...options });
}

export function createLogger(name: string): Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  }
  return rootLogger.child({ module: name });
}
