import type { IClaudeClient } from '../ai/claude.js';
import type { INapCatAdapter } from '../adapter/napcat.js';
import type { IWelcomeLogRepository } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';
import { BANGDREAM_PERSONA } from './chat.js';
import { RUNTIME_CHAT_MODEL } from '../config.js';

export interface WelcomeOptions {
  welcomeLog: IWelcomeLogRepository;
  claude: IClaudeClient;
  adapter: INapCatAdapter;
  botUserId: string;
  reWelcomeWindowMs?: number;
  burstCapPerGroup10Min?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RE_WELCOME_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BURST_CAP = 5;
const DEFAULT_MIN_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 8000;
const BURST_WINDOW_MS = 10 * 60 * 1000;

export class WelcomeModule {
  private readonly logger = createLogger('welcome');
  private readonly reWelcomeWindowMs: number;
  private readonly burstCapPerGroup10Min: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  // groupId → list of timestamps of welcomes in current burst window
  private readonly burstTracker = new Map<string, number[]>();

  constructor(private readonly opts: WelcomeOptions) {
    this.reWelcomeWindowMs = opts.reWelcomeWindowMs ?? DEFAULT_RE_WELCOME_WINDOW_MS;
    this.burstCapPerGroup10Min = opts.burstCapPerGroup10Min ?? DEFAULT_BURST_CAP;
    this.minDelayMs = opts.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  async handleJoin(groupId: string, newUserId: string): Promise<void> {
    if (newUserId === this.opts.botUserId) return;

    if (this._isBurstCapExceeded(groupId)) {
      this.logger.info({ groupId, newUserId }, 'welcome burst cap exceeded — skipping');
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const lastWelcome = this.opts.welcomeLog.lastWelcomeAt(groupId, newUserId);
    if (lastWelcome !== null && (nowSec - lastWelcome) * 1000 < this.reWelcomeWindowMs) {
      this.logger.debug({ groupId, newUserId }, 'user welcomed recently — skipping');
      return;
    }

    // Fetch nickname — NapCat doesn't expose get_stranger_info, fall back to "新人"
    const nickname = await this._fetchNickname(newUserId);

    const delay = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    await new Promise(r => setTimeout(r, delay));

    const prompt = `一个新人刚进群，qq号 ${newUserId}，昵称 "${nickname}"。
生成一条欢迎消息，必须：
- 以邦批的口吻自然问候，不要官方腔
- 可以带群内特色（比如问"你推谁"/"最喜欢哪个团"/"来日本 live 吗"），但不要信息量过载
- 长度 3-30 字，不要一本正经
- 不要说"欢迎加入群聊"这种八股
- 禁止 "<" 开头的任何输出

只输出那一句话，不要解释。`;

    let reply: string;
    try {
      const resp = await this.opts.claude.complete({
        model: RUNTIME_CHAT_MODEL,
        maxTokens: 80,
        system: [{ text: BANGDREAM_PERSONA, cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });
      reply = resp.text.trim();
    } catch (err) {
      this.logger.warn({ err, groupId, newUserId }, 'welcome Claude call failed — skipping');
      return;
    }

    if (!reply || reply.startsWith('<') || reply.length > 80) {
      this.logger.info({ groupId, newUserId, reply }, 'welcome reply rejected by validator — skipping');
      return;
    }

    const text = `[CQ:at,qq=${newUserId}] ${reply}`;
    await this.opts.adapter.send(groupId, text);

    this.opts.welcomeLog.record(groupId, newUserId, nowSec);
    this._trackBurst(groupId);
    this.logger.info({ groupId, newUserId, reply }, 'welcome sent');
  }

  private _isBurstCapExceeded(groupId: string): boolean {
    const now = Date.now();
    const cutoff = now - BURST_WINDOW_MS;
    const times = (this.burstTracker.get(groupId) ?? []).filter(t => t > cutoff);
    this.burstTracker.set(groupId, times);
    return times.length >= this.burstCapPerGroup10Min;
  }

  private _trackBurst(groupId: string): void {
    const times = this.burstTracker.get(groupId) ?? [];
    times.push(Date.now());
    this.burstTracker.set(groupId, times);
  }

  private async _fetchNickname(_userId: string): Promise<string> {
    // NapCat does not expose get_stranger_info — fall back to "新人"
    return '新人';
  }
}
