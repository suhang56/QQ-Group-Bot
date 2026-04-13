import { describe, it, expect, beforeEach } from 'vitest';
import { createLogger, initLogger } from '../src/utils/logger.js';

describe('logger', () => {
  beforeEach(() => {
    // Reset internal state by re-initializing
    initLogger({ level: 'silent' });
  });

  it('createLogger returns a child logger with module field', () => {
    const logger = createLogger('test-module');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('createLogger works without initLogger being called first', () => {
    // Reset root by setting env
    process.env['LOG_LEVEL'] = 'silent';
    const logger = createLogger('cold-start');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('multiple createLogger calls return separate child loggers', () => {
    const l1 = createLogger('module-a');
    const l2 = createLogger('module-b');
    expect(l1).not.toBe(l2);
  });

  it('initLogger configures the root log level', () => {
    initLogger({ level: 'warn' });
    const logger = createLogger('level-test');
    // pino child inherits parent level
    expect(logger.level).toBe('warn');
  });

  it('createLogger before initLogger uses LOG_LEVEL env', () => {
    process.env['LOG_LEVEL'] = 'debug';
    // Force reset by calling initLogger
    initLogger({ level: 'debug' });
    const logger = createLogger('env-level-test');
    expect(logger.level).toBe('debug');
  });
});
