import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

type AdapterInternal = {
  action: (action: string, params: Record<string, unknown>) => Promise<{ status: string; retcode: number; data: unknown; echo: string }>;
  logger: { warn: (...args: unknown[]) => void };
};

function makeAdapter(): { adapter: NapCatAdapter; internal: AdapterInternal } {
  const adapter = new NapCatAdapter('ws://unused');
  const internal = adapter as unknown as AdapterInternal;
  return { adapter, internal };
}

function timeoutErr(): Error {
  return new Error('Timeout calling downloadRichMedia for file xyz');
}

function plainErr(): Error {
  return new Error('network error');
}

function genericTimeoutErr(): Error {
  return new Error('Timeout waiting for something unrelated');
}

describe('NapCatAdapter.getImage retry on downloadRichMedia Timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries once on downloadRichMedia Timeout then succeeds → returns value, 2 calls, 1 warn', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValueOnce(timeoutErr())
      .mockResolvedValueOnce({
        status: 'ok',
        retcode: 0,
        data: { filename: 'a.jpg', url: 'http://x/a.jpg', size: 42, base64: 'b64data' },
        echo: '1',
      });
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    const promise = adapter.getImage('abcdef012345XYZ');
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual({ filename: 'a.jpg', url: 'http://x/a.jpg', size: 42, base64: 'b64data' });
    expect(actionSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [meta, msg] = warnSpy.mock.calls[0]!;
    expect(meta).toMatchObject({ file: 'abcdef012345', backoff: 500, attempt: 1 });
    expect(msg).toMatch(/getImage retry 1\/2 after Timeout .*waited 500ms/);
  });

  it('exhausts 3 attempts when all throw downloadRichMedia Timeout → throws, 3 calls, 3 warns (2 retry + 1 exhausted)', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(timeoutErr());
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    const promise = adapter.getImage('abcdef012345XYZ');
    const rejection = expect(promise).rejects.toThrow(/downloadRichMedia/);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);
    await rejection;

    expect(actionSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    const exhaustedCall = warnSpy.mock.calls[2]!;
    expect(exhaustedCall[0]).toMatchObject({ file: 'abcdef012345' });
    expect(exhaustedCall[1]).toMatch(/exhausted 3 attempts, giving up/);
  });

  it('throws immediately on non-timeout error → no retry, 1 call, 0 warns', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(plainErr());
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    await expect(adapter.getImage('abcdef012345XYZ')).rejects.toThrow('network error');

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws immediately on generic Timeout without downloadRichMedia keyword → no retry, 1 call, 0 warns', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(genericTimeoutErr());
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    await expect(adapter.getImage('abcdef012345XYZ')).rejects.toThrow(/Timeout waiting/);

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('succeeds on first try → no retry, 1 call, 0 warns', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockResolvedValueOnce({
        status: 'ok',
        retcode: 0,
        data: { filename: 'b.jpg', url: 'http://x/b.jpg', size: 7 },
        echo: '1',
      });
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    const result = await adapter.getImage('zzzzzzzzzzzzYYY');

    expect(result).toEqual({ filename: 'b.jpg', url: 'http://x/b.jpg', size: 7, base64: undefined });
    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
