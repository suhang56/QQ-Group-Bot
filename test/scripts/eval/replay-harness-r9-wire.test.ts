import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { constructChatModule } from '../../../scripts/eval/replay-runner-core.js';
import { MockClaudeClient } from '../../../scripts/eval/mock-llm.js';
import { ReplyPlanner } from '../../../src/modules/reply-planner.js';
import { buildSyntheticReplayDb } from '../../../scripts/eval/build-synthetic-replay-db.js';

const ENV_KEY = 'R9_REPLYER_LITE_ENABLED';
const REPO = path.resolve(__dirname, '../../..');
// Dedicated synthetic fixture path for this file (avoid races with parallel
// test files that also call buildSyntheticReplayDb on the shared canonical
// path). Filename still contains 'synthetic' so constructChatModule tripwire
// is satisfied.
const FIXTURE_DB_SRC = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic-r9wire.sqlite');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r9-wire-${prefix}-`));
}

function makeTmpDb(prefix: string): string {
  // constructChatModule rejects DB paths without .tmp or 'synthetic'. We copy
  // the (already-built) synthetic fixture into a tmp path that satisfies BOTH
  // tripwires: filename contains 'synthetic' AND parent dir is .tmp-ish.
  const dir = tmpDir(prefix);
  const dst = path.join(dir, 'synthetic.db');
  fs.copyFileSync(FIXTURE_DB_SRC, dst);
  return dst;
}

describe('replay-runner harness — R9 wire (T-1 / T-2 / T-2b)', () => {
  let savedEnv: string | undefined;

  beforeAll(() => {
    // Build synthetic fixture once. Per-test rebuild races sibling parallel
    // test files (replay-runner-mock.test.ts, replay-runner-r9-smoke.test.ts)
    // that also build the same path → 'database is locked' on concurrent open.
    buildSyntheticReplayDb(FIXTURE_DB_SRC);
  });

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('T-1: R9_REPLYER_LITE_ENABLED=1 -> returned replyPlanner is a ReplyPlanner instance', () => {
    process.env[ENV_KEY] = '1';
    const tmpDb = makeTmpDb('t1');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    expect(result.replyPlanner).not.toBeNull();
    expect(result.replyPlanner).toBeInstanceOf(ReplyPlanner);
    expect(result.chat).toBeDefined();
    expect(result.db).toBeDefined();
  });

  it('T-2: R9_REPLYER_LITE_ENABLED unset -> returned replyPlanner is null (default-null arm)', () => {
    delete process.env[ENV_KEY];
    const tmpDb = makeTmpDb('t2');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    expect(result.replyPlanner).toBeNull();
  });

  it('T-2b (edge): R9_REPLYER_LITE_ENABLED="" -> null (strict ===, not truthy-coerce)', () => {
    process.env[ENV_KEY] = '';
    const tmpDb = makeTmpDb('t2b');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    expect(result.replyPlanner).toBeNull();
  });
});
