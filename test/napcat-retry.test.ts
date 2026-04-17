import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NapCatAdapter } from '../src/adapter/napcat.js';
import { NapCatActionError } from '../src/utils/errors.js';
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

function getImageTimeout(): NapCatActionError {
  return new NapCatActionError('get_image', new Error('Action timed out'));
}

function getImageFileNotFound(): NapCatActionError {
  return new NapCatActionError('get_image', new Error('file not found'));
}

describe('NapCatAdapter.getImage retry on get_image timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Case 1 positive: retries twice on get_image timeout then succeeds on 3rd → 3 calls total', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValueOnce(getImageTimeout())
      .mockRejectedValueOnce(getImageTimeout())
      .mockResolvedValueOnce({
        status: 'ok',
        retcode: 0,
        data: { filename: 'a.jpg', url: 'http://x/a.jpg', size: 42, base64: 'b64data' },
        echo: '1',
      });
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    const promise = adapter.getImage('abcdef012345XYZ');
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result).toEqual({ filename: 'a.jpg', url: 'http://x/a.jpg', size: 42, base64: 'b64data' });
    expect(actionSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const [meta1, msg1] = warnSpy.mock.calls[0]!;
    expect(meta1).toMatchObject({ file: 'abcdef012345', backoff: 500, attempt: 1 });
    expect(msg1).toMatch(/getImage retry 1\/2 after get_image timeout .*waited 500ms/);
    const [meta2, msg2] = warnSpy.mock.calls[1]!;
    expect(meta2).toMatchObject({ file: 'abcdef012345', backoff: 1500, attempt: 2 });
    expect(msg2).toMatch(/getImage retry 2\/2 after get_image timeout .*waited 1500ms/);
  });

  it('Case 2 positive: exhausts all 3 attempts on persistent timeout → re-throws + exhausted warn', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(getImageTimeout());
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    const promise = adapter.getImage('abcdef012345XYZ');
    const rejection = expect(promise).rejects.toBeInstanceOf(NapCatActionError);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);
    await rejection;

    expect(actionSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    const exhaustedCall = warnSpy.mock.calls[2]!;
    expect(exhaustedCall[0]).toMatchObject({ file: 'abcdef012345' });
    expect(exhaustedCall[1]).toMatch(/exhausted retries after get_image timeout .*total 2000ms/);
  });

  it('Case 3 negative: NapCatActionError for different action (send_private_msg timed out) → no retry, 1 call', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(new NapCatActionError('send_private_msg', new Error('Action timed out')));
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    await expect(adapter.getImage('abcdef012345XYZ')).rejects.toBeInstanceOf(NapCatActionError);

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Case 4 negative: NapCatActionError get_image but non-timeout cause (retcode=1200) → no retry, 1 call', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(new NapCatActionError('get_image', new Error('retcode=1200')));
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    await expect(adapter.getImage('abcdef012345XYZ')).rejects.toBeInstanceOf(NapCatActionError);

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Case 5 negative: plain Error with matching message but not NapCatActionError instance → no retry, 1 call', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(new Error("OneBot action 'get_image' failed: Action timed out"));
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    await expect(adapter.getImage('abcdef012345XYZ')).rejects.toThrow(/timed out/);

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Case 6 negative: non-Error rejection (string) → no retry, 1 call', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue('boom-string');
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    await expect(adapter.getImage('abcdef012345XYZ')).rejects.toBe('boom-string');

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Case 7 backoff timing: retries use exactly 500ms then 1500ms (fake timer)', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValueOnce(getImageTimeout())
      .mockRejectedValueOnce(getImageTimeout())
      .mockResolvedValueOnce({
        status: 'ok',
        retcode: 0,
        data: { filename: 'c.jpg', url: 'http://x/c.jpg', size: 10 },
        echo: '1',
      });

    const promise = adapter.getImage('abcdef012345XYZ');

    // After 1st failure, pending timer is 500ms. Advance 499ms → still pending, only 1 call made.
    await vi.advanceTimersByTimeAsync(499);
    expect(actionSpy).toHaveBeenCalledTimes(1);
    // Advance final 1ms → 2nd call fires.
    await vi.advanceTimersByTimeAsync(1);
    expect(actionSpy).toHaveBeenCalledTimes(2);

    // After 2nd failure, pending timer is 1500ms. Advance 1499ms → still only 2 calls.
    await vi.advanceTimersByTimeAsync(1499);
    expect(actionSpy).toHaveBeenCalledTimes(2);
    // Advance final 1ms → 3rd call fires.
    await vi.advanceTimersByTimeAsync(1);

    const result = await promise;
    expect(result.filename).toBe('c.jpg');
    expect(actionSpy).toHaveBeenCalledTimes(3);
  });

  it('Case 8 positive: persistent file-not-found → 3 attempts then exhausted-warn mentions file-not-found', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(getImageFileNotFound());
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    const promise = adapter.getImage('abcdef012345XYZ');
    const rejection = expect(promise).rejects.toBeInstanceOf(NapCatActionError);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);
    await rejection;

    expect(actionSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[0]![0]).toMatchObject({ category: 'file-not-found' });
    expect(warnSpy.mock.calls[0]![1]).toMatch(/getImage retry 1\/2 after get_image file-not-found/);
    expect(warnSpy.mock.calls[1]![0]).toMatchObject({ category: 'file-not-found' });
    expect(warnSpy.mock.calls[1]![1]).toMatch(/getImage retry 2\/2 after get_image file-not-found/);
    expect(warnSpy.mock.calls[2]![0]).toMatchObject({ file: 'abcdef012345', category: 'file-not-found' });
    expect(warnSpy.mock.calls[2]![1]).toMatch(/exhausted retries after get_image file-not-found .*total 2000ms/);
  });

  it('Case 9 positive: file-not-found then succeeds on 2nd → 2 calls, retry warn mentions file-not-found', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValueOnce(getImageFileNotFound())
      .mockResolvedValueOnce({
        status: 'ok',
        retcode: 0,
        data: { filename: 'd.jpg', url: 'http://x/d.jpg', size: 99 },
        echo: '1',
      });
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    const promise = adapter.getImage('abcdef012345XYZ');
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.filename).toBe('d.jpg');
    expect(actionSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatchObject({ file: 'abcdef012345', backoff: 500, attempt: 1, category: 'file-not-found' });
    expect(warnSpy.mock.calls[0]![1]).toMatch(/getImage retry 1\/2 after get_image file-not-found .*waited 500ms/);
  });

  it('Case 10 negative: get_image with non-transient cause (invalid file format) → no retry, 1 call', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValue(new NapCatActionError('get_image', new Error('invalid file format')));
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    await expect(adapter.getImage('abcdef012345XYZ')).rejects.toBeInstanceOf(NapCatActionError);

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Case 11 mixed: timeout then file-not-found then success → 3 calls, categories reflect each attempt', async () => {
    const { adapter, internal } = makeAdapter();
    const actionSpy = vi
      .spyOn(internal, 'action')
      .mockRejectedValueOnce(getImageTimeout())
      .mockRejectedValueOnce(getImageFileNotFound())
      .mockResolvedValueOnce({
        status: 'ok',
        retcode: 0,
        data: { filename: 'e.jpg', url: 'http://x/e.jpg', size: 77 },
        echo: '1',
      });
    const warnSpy = vi.spyOn(internal.logger, 'warn');

    const promise = adapter.getImage('abcdef012345XYZ');
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result.filename).toBe('e.jpg');
    expect(actionSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]![0]).toMatchObject({ category: 'timeout', attempt: 1, backoff: 500 });
    expect(warnSpy.mock.calls[0]![1]).toMatch(/getImage retry 1\/2 after get_image timeout .*waited 500ms/);
    expect(warnSpy.mock.calls[1]![0]).toMatchObject({ category: 'file-not-found', attempt: 2, backoff: 1500 });
    expect(warnSpy.mock.calls[1]![1]).toMatch(/getImage retry 2\/2 after get_image file-not-found .*waited 1500ms/);
  });
});
