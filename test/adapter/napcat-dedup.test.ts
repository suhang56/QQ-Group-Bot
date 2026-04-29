import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NapCatAdapter, type GroupMessage, type PrivateMessage } from '../../src/adapter/napcat.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

type FrameHandle = { handleFrame(f: object): void };
const callHandleFrame = (a: NapCatAdapter, f: object): void =>
  (a as unknown as FrameHandle).handleFrame(f);

const groupFrame = (messageId: number | undefined, overrides: Record<string, unknown> = {}): object => ({
  post_type: 'message',
  message_type: 'group',
  message_id: messageId,
  group_id: 100,
  user_id: 200,
  sender: { nickname: 'tester', role: 'member' },
  raw_message: 'ygfn',
  message: 'ygfn',
  time: Math.floor(Date.now() / 1000),
  ...overrides,
});

const privateFrame = (messageId: number | undefined): object => ({
  post_type: 'message',
  message_type: 'private',
  message_id: messageId,
  user_id: 200,
  sender: { nickname: 'tester' },
  message: 'hello',
  time: Math.floor(Date.now() / 1000),
});

const noticeFrame = (): object => ({
  post_type: 'notice',
  notice_type: 'group_increase',
  group_id: 100,
  user_id: 200,
  time: Math.floor(Date.now() / 1000),
});

type SeenMap = { seenMessageIds: Map<string, number> };
const getSeen = (a: NapCatAdapter): Map<string, number> =>
  (a as unknown as SeenMap).seenMessageIds;

describe('NapCatAdapter dedup', () => {
  let adapter: NapCatAdapter;

  beforeEach(() => {
    adapter = new NapCatAdapter('ws://mock', undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    adapter.removeAllListeners();
  });

  // T1 — group dedup within TTL: same group message_id twice → emit fires once
  it('T1: group dedup within TTL', () => {
    const spy = vi.fn();
    adapter.on('message.group', spy);
    callHandleFrame(adapter, groupFrame(999));
    callHandleFrame(adapter, groupFrame(999));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // T2 — private dedup within TTL
  it('T2: private dedup within TTL', () => {
    const spy = vi.fn();
    adapter.on('message.private', spy);
    callHandleFrame(adapter, privateFrame(999));
    callHandleFrame(adapter, privateFrame(999));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // T3 — cross-type same messageId: group then private with same id → only group emits
  it('T3: cross-type same messageId — second drop', () => {
    const groupSpy = vi.fn();
    const privateSpy = vi.fn();
    adapter.on('message.group', groupSpy);
    adapter.on('message.private', privateSpy);
    callHandleFrame(adapter, groupFrame(999));
    callHandleFrame(adapter, privateFrame(999));
    expect(groupSpy).toHaveBeenCalledTimes(1);
    expect(privateSpy).toHaveBeenCalledTimes(0);
  });

  // T4 — empty messageId never deduped
  it('T4: empty messageId is never deduped', () => {
    const spy = vi.fn();
    adapter.on('message.group', spy);
    callHandleFrame(adapter, groupFrame(undefined));
    callHandleFrame(adapter, groupFrame(undefined));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // T5 — TTL expiry re-emits
  it('T5: TTL expiry re-emits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const spy = vi.fn();
    adapter.on('message.group', spy);

    callHandleFrame(adapter, groupFrame(999));
    expect(spy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);

    callHandleFrame(adapter, groupFrame(999));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // T6 — Map does not grow unbounded after TTL window
  it('T6: Map size bounded by lazy sweep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const spy = vi.fn();
    adapter.on('message.group', spy);

    for (let i = 1; i <= 1000; i++) {
      callHandleFrame(adapter, groupFrame(i));
    }
    expect(spy).toHaveBeenCalledTimes(1000);
    expect(getSeen(adapter).size).toBe(1000);

    vi.advanceTimersByTime(61_000);

    callHandleFrame(adapter, groupFrame(1));
    // After sweep: all 1000 expired entries purged, then frame(1) re-inserted as fresh.
    expect(spy).toHaveBeenCalledTimes(1001);
    expect(getSeen(adapter).size).toBe(1);
  });

  // T7 — two distinct IDs both emitted
  it('T7: distinct messageIds both emit', () => {
    const spy = vi.fn();
    adapter.on('message.group', spy);
    callHandleFrame(adapter, groupFrame(111));
    callHandleFrame(adapter, groupFrame(222));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // T8 — notice frame not affected (no message_id; dedup never engaged)
  it('T8: notice frames untouched by dedup', () => {
    const spy = vi.fn();
    adapter.on('notice.group_increase', spy);
    callHandleFrame(adapter, noticeFrame());
    callHandleFrame(adapter, noticeFrame());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(getSeen(adapter).size).toBe(0);
  });

  // T9 — concurrency same tick: two identical frames pushed back-to-back synchronously
  it('T9: same-tick duplicate dropped', () => {
    const spy = vi.fn();
    adapter.on('message.group', spy);
    // Synchronous back-to-back invocation in one statement block
    callHandleFrame(adapter, groupFrame(999));
    callHandleFrame(adapter, groupFrame(999));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // T10 — debug log on duplicate
  it('T10: debug log fires once per dropped duplicate', () => {
    type LoggerHolder = { logger: { debug: (...args: unknown[]) => void } };
    const debugSpy = vi.spyOn((adapter as unknown as LoggerHolder).logger, 'debug');

    callHandleFrame(adapter, groupFrame(999));
    expect(debugSpy).not.toHaveBeenCalled();

    callHandleFrame(adapter, groupFrame(999));
    expect(debugSpy).toHaveBeenCalledTimes(1);

    const [logObj, logMsg] = debugSpy.mock.calls[0]!;
    expect(logObj).toMatchObject({
      messageId: '999',
      message_type: 'group',
    });
    expect(logObj).toHaveProperty('mapSize');
    expect(logObj).toHaveProperty('firstSeenMs');
    expect(logObj).toHaveProperty('ageMs');
    expect(logMsg).toBe('[dedup] duplicate frame dropped');
  });

  // Sanity: GroupMessage / PrivateMessage shape preserved (regression guard)
  it('preserves message payload shape on first arrival', () => {
    const groupReceived: GroupMessage[] = [];
    const privateReceived: PrivateMessage[] = [];
    adapter.on('message.group', m => groupReceived.push(m));
    adapter.on('message.private', m => privateReceived.push(m));
    callHandleFrame(adapter, groupFrame(42));
    callHandleFrame(adapter, privateFrame(43));
    expect(groupReceived[0]?.messageId).toBe('42');
    expect(privateReceived[0]?.messageId).toBe('43');
  });
});
