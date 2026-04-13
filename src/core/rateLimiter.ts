interface BucketState {
  count: number;
  windowStart: number;
}

interface LimitConfig {
  max: number;
  windowMs: number;
}

const COMMAND_LIMITS: Record<string, LimitConfig> = {
  mimic:   { max: 3,  windowMs: 60_000 },
  rules:   { max: 5,  windowMs: 60_000 },
  default: { max: 10, windowMs: 60_000 },
};

const GROUP_LIMITS: Record<string, LimitConfig> = {
  chat:    { max: 20, windowMs: 60_000 },
  default: { max: 60, windowMs: 60_000 },
};

function getConfig(map: Record<string, LimitConfig>, key: string): LimitConfig {
  return map[key] ?? map['default']!;
}

function check(buckets: Map<string, BucketState>, key: string, cfg: LimitConfig, consume: boolean): boolean {
  const now = Date.now();
  let state = buckets.get(key);

  if (!state || now - state.windowStart >= cfg.windowMs) {
    state = { count: 0, windowStart: now };
  }

  if (state.count >= cfg.max) {
    if (consume) buckets.set(key, state);
    return false;
  }

  if (consume) {
    buckets.set(key, { count: state.count + 1, windowStart: state.windowStart });
  }
  return true;
}

export class RateLimiter {
  private readonly userBuckets = new Map<string, BucketState>();
  private readonly groupBuckets = new Map<string, BucketState>();

  checkUser(userId: string, command: string): boolean {
    const cfg = getConfig(COMMAND_LIMITS, command);
    const key = `${userId}:${command === 'mimic' || command === 'rules' ? command : 'default'}`;
    return check(this.userBuckets, key, cfg, true);
  }

  checkGroup(groupId: string, action: string): boolean {
    const cfg = getConfig(GROUP_LIMITS, action);
    const key = `${groupId}:${action === 'chat' ? 'chat' : 'default'}`;
    return check(this.groupBuckets, key, cfg, true);
  }

  cooldownSecondsUser(userId: string, command: string): number {
    const cfg = getConfig(COMMAND_LIMITS, command);
    const key = `${userId}:${command === 'mimic' || command === 'rules' ? command : 'default'}`;
    const state = this.userBuckets.get(key);
    if (!state || state.count < cfg.max) return 0;
    const elapsed = Date.now() - state.windowStart;
    return Math.max(0, Math.ceil((cfg.windowMs - elapsed) / 1000));
  }
}
