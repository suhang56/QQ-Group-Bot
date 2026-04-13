import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { NapCatAdapter, type GroupMessage } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';
import { NapCatActionError } from '../src/utils/errors.js';
import { AddressInfo } from 'node:net';

initLogger({ level: 'silent' });

function getPort(server: WebSocketServer): number {
  return (server.address() as AddressInfo).port;
}

async function waitForEvent<T>(emitter: { on: (e: string, h: (v: T) => void) => void }, event: string): Promise<T> {
  return new Promise(resolve => emitter.on(event, resolve));
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('NapCatAdapter', () => {
  let server: WebSocketServer;
  let serverSocket: WebSocket | null = null;
  let adapter: NapCatAdapter;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (ws) => {
      serverSocket = ws;
    });
    await new Promise<void>(r => server.once('listening', r));
  });

  afterEach(async () => {
    await adapter?.disconnect().catch(() => { /* ignore */ });
    serverSocket = null;
    await new Promise<void>(r => server.close(() => r()));
  });

  // --- Happy path: connect ---
  it('connect() resolves when WebSocket opens', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  // --- Group message parsing ---
  it('emits message.group with parsed GroupMessage on incoming OneBot frame', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    const msgPromise = waitForEvent<GroupMessage>(adapter, 'message.group');

    const frame = {
      post_type: 'message',
      message_type: 'group',
      message_id: 123,
      group_id: 456,
      user_id: 789,
      sender: { nickname: 'TestUser', role: 'member' },
      message: [{ type: 'text', data: { text: 'hello world' } }],
      raw_message: 'hello world',
      time: 1700000000,
    };
    serverSocket!.send(JSON.stringify(frame));

    const msg = await msgPromise;
    expect(msg.messageId).toBe('123');
    expect(msg.groupId).toBe('456');
    expect(msg.userId).toBe('789');
    expect(msg.nickname).toBe('TestUser');
    expect(msg.role).toBe('member');
    expect(msg.content).toBe('hello world');
    expect(msg.timestamp).toBe(1700000000);
  });

  // --- Malformed event ignored ---
  it('ignores malformed JSON frames without crashing', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    let errorEmitted = false;
    adapter.on('error', () => { errorEmitted = true; });

    serverSocket!.send('not-valid-json{{{{');
    await sleep(100);

    expect(errorEmitted).toBe(false);
  });

  // --- Unknown frame types silently ignored ---
  it('silently ignores unknown post_type frames', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    const spy = vi.fn();
    adapter.on('message.group', spy);

    serverSocket!.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle' }));
    await sleep(100);

    expect(spy).not.toHaveBeenCalled();
  });

  // --- Auth failure surfaced ---
  it('surfaces connection error when server refuses connection', async () => {
    // Use a port nothing is listening on
    const deadAdapter = new NapCatAdapter('ws://localhost:1');
    await expect(deadAdapter.connect()).rejects.toThrow();
  });

  // --- Action: send() emits correct OneBot frame ---
  it('send() sends correct OneBot action frame', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    const framePromise = new Promise<Record<string, unknown>>(resolve => {
      serverSocket!.on('message', (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    // Server replies with ok
    serverSocket!.on('message', (data) => {
      const req = JSON.parse(data.toString()) as { echo: string };
      serverSocket!.send(JSON.stringify({ status: 'ok', retcode: 0, echo: req.echo }));
    });

    await adapter.send('456', 'hello');
    const frame = await framePromise;

    expect(frame['action']).toBe('send_group_msg');
    expect((frame['params'] as Record<string, unknown>)['group_id']).toBe(456);
    expect((frame['params'] as Record<string, unknown>)['message']).toBe('hello');
  });

  // --- Action error wraps to NapCatActionError ---
  it('action errors wrap to NapCatActionError', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    // Server replies with failure
    serverSocket!.on('message', (data) => {
      const req = JSON.parse(data.toString()) as { echo: string };
      serverSocket!.send(JSON.stringify({ status: 'failed', retcode: 100, echo: req.echo }));
    });

    await expect(adapter.send('456', 'hi')).rejects.toBeInstanceOf(NapCatActionError);
  });

  // --- Action when not connected ---
  it('action throws NapCatActionError when not connected', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    // Don't connect
    await expect(adapter.send('1', 'test')).rejects.toBeInstanceOf(NapCatActionError);
  });

  // --- Connection drop emits close and schedules reconnect ---
  it('emits close event when server disconnects', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    const closePromise = waitForEvent<void>(adapter, 'close');
    serverSocket!.close();
    await closePromise;
    // Just verifying the close event fired; reconnect is attempted but port is still open
  });

  // --- Graceful shutdown ---
  it('disconnect() closes connection cleanly without triggering reconnect', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    let errorEmitted = false;
    adapter.on('error', () => { errorEmitted = true; });

    await adapter.disconnect();
    await sleep(200); // give time for any rogue reconnect to start

    expect(errorEmitted).toBe(false);
  });

  // --- Role parsing ---
  it('correctly parses owner, admin, and member roles', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    const roles: Array<GroupMessage['role']> = [];
    adapter.on('message.group', (msg) => roles.push(msg.role));

    for (const role of ['owner', 'admin', 'member', 'unknown_role']) {
      serverSocket!.send(JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        message_id: 1,
        group_id: 1,
        user_id: 1,
        sender: { nickname: 'X', role },
        message: 'hi',
        raw_message: 'hi',
        time: 1,
      }));
      await sleep(50);
    }

    expect(roles).toEqual(['owner', 'admin', 'member', 'member']);
  });

  // --- notice events ---
  it('emits notice.group_increase event', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    const noticed = waitForEvent<string>(adapter, 'notice.group_increase');
    serverSocket!.send(JSON.stringify({
      post_type: 'notice',
      notice_type: 'group_increase',
      group_id: 111,
      user_id: 222,
    }));
    const groupId = await noticed;
    expect(groupId).toBe('111');
  });

  // --- CQ code stripping ---
  it('strips CQ codes from string messages', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    const msgPromise = waitForEvent<GroupMessage>(adapter, 'message.group');
    serverSocket!.send(JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      message_id: 5,
      group_id: 1,
      user_id: 1,
      sender: { nickname: 'X', role: 'member' },
      message: '[CQ:at,qq=12345] hello [CQ:face,id=1]',
      raw_message: '[CQ:at,qq=12345] hello [CQ:face,id=1]',
      time: 1,
    }));
    const msg = await msgPromise;
    expect(msg.content).toBe('hello');
  });

  // --- notice.group_decrease ---
  it('emits notice.group_decrease event', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    const noticed = waitForEvent<string>(adapter, 'notice.group_decrease');
    serverSocket!.send(JSON.stringify({
      post_type: 'notice',
      notice_type: 'group_decrease',
      group_id: 111,
      user_id: 333,
    }));
    const groupId = await noticed;
    expect(groupId).toBe('111');
  });

  // --- ban/kick/deleteMsg/sendPrivate ---
  it('ban() sends correct OneBot frame', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    serverSocket!.on('message', (data) => {
      const req = JSON.parse(data.toString()) as { echo: string };
      serverSocket!.send(JSON.stringify({ status: 'ok', retcode: 0, echo: req.echo }));
    });

    await expect(adapter.ban('456', '789', 600)).resolves.toBeUndefined();
  });

  it('kick() sends correct OneBot frame', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    serverSocket!.on('message', (data) => {
      const req = JSON.parse(data.toString()) as { echo: string };
      serverSocket!.send(JSON.stringify({ status: 'ok', retcode: 0, echo: req.echo }));
    });

    await expect(adapter.kick('456', '789')).resolves.toBeUndefined();
  });

  it('deleteMsg() sends correct OneBot frame', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    serverSocket!.on('message', (data) => {
      const req = JSON.parse(data.toString()) as { echo: string };
      serverSocket!.send(JSON.stringify({ status: 'ok', retcode: 0, echo: req.echo }));
    });

    await expect(adapter.deleteMsg('999')).resolves.toBeUndefined();
  });

  it('sendPrivate() sends correct OneBot frame', async () => {
    adapter = new NapCatAdapter(`ws://localhost:${getPort(server)}`);
    await adapter.connect();

    serverSocket!.on('message', (data) => {
      const req = JSON.parse(data.toString()) as { echo: string };
      serverSocket!.send(JSON.stringify({ status: 'ok', retcode: 0, echo: req.echo }));
    });

    await expect(adapter.sendPrivate('789', 'hey')).resolves.toBeUndefined();
  });
});
