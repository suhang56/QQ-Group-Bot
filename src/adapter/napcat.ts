import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { NapCatActionError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

export interface GroupMessage {
  messageId: string;
  groupId: string;
  userId: string;
  nickname: string;
  role: 'owner' | 'admin' | 'member';
  content: string;
  rawContent: string;
  timestamp: number;
}

export interface AdapterEvents {
  'message.group': (msg: GroupMessage) => void;
  'notice.group_increase': (groupId: string, userId: string) => void;
  'notice.group_decrease': (groupId: string, userId: string) => void;
  'error': (err: Error) => void;
  'close': () => void;
}

export interface GroupNotice {
  noticeId: string;
  senderId: string;
  publishTime: number;
  message: string;
}

export interface INapCatAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on<K extends keyof AdapterEvents>(event: K, handler: AdapterEvents[K]): void;
  /** Send a group message. Returns the OneBot message_id, or null if unavailable. */
  send(groupId: string, text: string): Promise<number | null>;
  ban(groupId: string, userId: string, durationSeconds: number): Promise<void>;
  kick(groupId: string, userId: string): Promise<void>;
  deleteMsg(messageId: string): Promise<void>;
  sendPrivate(userId: string, text: string): Promise<void>;
  getGroupNotices(groupId: string): Promise<GroupNotice[]>;
  /** Resolve a CQ image file token via OneBot get_image — bypasses QQ CDN auth restrictions. */
  getImage(file: string): Promise<{ filename: string; url: string; size: number; base64?: string }>;
}

interface OneBotFrame {
  post_type?: string;
  message_type?: string;
  notice_type?: string;
  message_id?: number;
  group_id?: number;
  user_id?: number;
  sender?: {
    nickname?: string;
    role?: string;
  };
  raw_message?: string;
  message?: string | Array<{ type: string; data: { text?: string } }>;
  sub_type?: string;
  time?: number;
}

interface OneBotActionResponse {
  status: string;
  retcode: number;
  data?: unknown;
  echo?: string;
}

function stripCQCodes(raw: string): string {
  return raw.replace(/\[CQ:[^\]]+\]/g, '').trim();
}

function extractText(message: OneBotFrame['message']): string {
  if (!message) return '';
  if (typeof message === 'string') return stripCQCodes(message);
  return message
    .filter(seg => seg.type === 'text')
    .map(seg => seg.data.text ?? '')
    .join('')
    .trim();
}

type PendingResolve = (value: OneBotActionResponse) => void;
type PendingReject = (reason: unknown) => void;

export class NapCatAdapter extends EventEmitter implements INapCatAdapter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnects = 3;
  private readonly reconnectDelays = [2000, 5000, 10000];
  private pendingActions = new Map<string, { resolve: PendingResolve; reject: PendingReject; actionName: string }>();
  private echoCounter = 0;
  private disconnecting = false;
  private readonly logger = createLogger('adapter');

  constructor(
    private readonly wsUrl: string,
    private readonly accessToken?: string
  ) {
    super();
  }

  on<K extends keyof AdapterEvents>(event: K, handler: AdapterEvents[K]): this {
    return super.on(event, handler as (...args: unknown[]) => void);
  }

  async connect(): Promise<void> {
    this.disconnecting = false;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.accessToken) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
      }

      const ws = new WebSocket(this.wsUrl, { headers });
      this.ws = ws;

      ws.once('open', () => {
        this.reconnectAttempts = 0;
        this.logger.info({ url: this.wsUrl }, 'NapCat WebSocket connected');
        resolve();
      });

      ws.once('error', (err) => {
        this.logger.error({ err }, 'WebSocket connection error');
        reject(err);
      });

      ws.on('message', (data) => {
        try {
          this.handleFrame(JSON.parse(data.toString()) as OneBotFrame | OneBotActionResponse);
        } catch (err) {
          this.logger.warn({ err }, 'Malformed WebSocket frame — ignored');
        }
      });

      ws.on('close', () => {
        this.logger.info('WebSocket closed');
        super.emit('close');
        if (!this.disconnecting) {
          void this.scheduleReconnect();
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.ws?.close();
    this.ws = null;
    this.logger.info('NapCat adapter disconnected');
  }

  async send(groupId: string, text: string): Promise<number | null> {
    const resp = await this.action('send_group_msg', {
      group_id: Number(groupId),
      message: text,
    });
    const data = resp.data as { message_id?: number } | undefined;
    return data?.message_id ?? null;
  }

  async ban(groupId: string, userId: string, durationSeconds: number): Promise<void> {
    await this.action('set_group_ban', {
      group_id: Number(groupId),
      user_id: Number(userId),
      duration: durationSeconds,
    });
  }

  async kick(groupId: string, userId: string): Promise<void> {
    await this.action('set_group_kick', {
      group_id: Number(groupId),
      user_id: Number(userId),
    });
  }

  async deleteMsg(messageId: string): Promise<void> {
    await this.action('delete_msg', {
      message_id: Number(messageId),
    });
  }

  async sendPrivate(userId: string, text: string): Promise<void> {
    await this.action('send_private_msg', {
      user_id: Number(userId),
      message: text,
    });
  }

  async getImage(file: string): Promise<{ filename: string; url: string; size: number; base64?: string }> {
    const resp = await this.action('get_image', { file });
    const data = resp.data as { filename?: string; url?: string; size?: number; base64?: string } | undefined;
    return {
      filename: data?.filename ?? '',
      url: data?.url ?? '',
      size: data?.size ?? 0,
      base64: data?.base64,
    };
  }

  async getGroupNotices(groupId: string): Promise<GroupNotice[]> {
    const resp = await this.action('_get_group_notice', { group_id: Number(groupId) });
    const data = resp.data as Array<{
      notice_id?: string;
      sender_id?: number;
      publish_time?: number;
      message?: { text?: string } | string;
    }> | undefined;
    if (!Array.isArray(data)) return [];
    return data.map(n => ({
      noticeId: String(n.notice_id ?? ''),
      senderId: String(n.sender_id ?? ''),
      publishTime: n.publish_time ?? 0,
      message: typeof n.message === 'string'
        ? n.message
        : (n.message?.text ?? ''),
    })).filter(n => n.noticeId && n.message);
  }

  private handleFrame(frame: OneBotFrame | OneBotActionResponse): void {
    // Action response (has echo field set by us)
    if ('echo' in frame && frame.echo) {
      const pending = this.pendingActions.get(frame.echo);
      if (pending) {
        this.pendingActions.delete(frame.echo);
        const resp = frame as OneBotActionResponse;
        if (resp.status === 'ok' || resp.retcode === 0) {
          pending.resolve(resp);
        } else {
          pending.reject(new NapCatActionError(pending.actionName, new Error(`retcode=${resp.retcode}`)));
        }
      }
      return;
    }

    const evt = frame as OneBotFrame;

    if (evt.post_type === 'message' && evt.message_type === 'group') {
      const rawContent = typeof evt.message === 'string'
        ? evt.message
        : (evt.raw_message ?? '');
      const content = extractText(evt.message);

      const roleRaw = evt.sender?.role;
      const role: GroupMessage['role'] =
        roleRaw === 'owner' ? 'owner'
        : roleRaw === 'admin' ? 'admin'
        : 'member';

      const msg: GroupMessage = {
        messageId: String(evt.message_id ?? ''),
        groupId: String(evt.group_id ?? ''),
        userId: String(evt.user_id ?? ''),
        nickname: evt.sender?.nickname ?? '',
        role,
        content,
        rawContent,
        timestamp: evt.time ?? Math.floor(Date.now() / 1000),
      };

      this.logger.trace({ messageId: msg.messageId, groupId: msg.groupId, userId: msg.userId }, 'group message received');
      super.emit('message.group', msg);
      return;
    }

    if (evt.post_type === 'notice') {
      if (evt.notice_type === 'group_increase') {
        super.emit('notice.group_increase', String(evt.group_id ?? ''), String(evt.user_id ?? ''));
      } else if (evt.notice_type === 'group_decrease') {
        super.emit('notice.group_decrease', String(evt.group_id ?? ''), String(evt.user_id ?? ''));
      }
      return;
    }

    // Unknown frame types are silently ignored per spec
  }

  private async action(action: string, params: Record<string, unknown>): Promise<OneBotActionResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new NapCatActionError(action, new Error('WebSocket not connected'));
    }

    const echo = String(++this.echoCounter);
    const payload = JSON.stringify({ action, params, echo });

    return new Promise((resolve, reject) => {
      this.pendingActions.set(echo, { resolve, reject, actionName: action });

      this.ws!.send(payload, (err) => {
        if (err) {
          this.pendingActions.delete(echo);
          reject(new NapCatActionError(action, err));
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingActions.has(echo)) {
          this.pendingActions.delete(echo);
          reject(new NapCatActionError(action, new Error('Action timed out')));
        }
      }, 10_000);
    });
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnects) {
      this.logger.fatal('Max reconnect attempts reached — giving up');
      super.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    const delay = this.reconnectDelays[this.reconnectAttempts] ?? 10000;
    this.reconnectAttempts++;
    this.logger.warn({ attempt: this.reconnectAttempts, delayMs: delay }, 'Scheduling reconnect');

    await new Promise(r => setTimeout(r, delay));

    try {
      await this.connect();
      this.logger.info({ attempt: this.reconnectAttempts }, 'Reconnected successfully');
    } catch (err) {
      this.logger.error({ err, attempt: this.reconnectAttempts }, 'Reconnect failed');
      void this.scheduleReconnect();
    }
  }
}
