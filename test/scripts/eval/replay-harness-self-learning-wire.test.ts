import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock MUST be hoisted above any import of the module under test.
// Replaces SelfLearningModule with a subclass that throws on `new` when
// botUserId === 'force-throw' sentinel (T-1c). Falls through to the real
// constructor for T-1 and T-1b (botQQ: 'bot-test'). File-scoped — does NOT
// affect sibling test files per vitest's per-file module-graph isolation
// (see DEV-READY §0 vi.mock fork-pool audit).
vi.mock('../../../src/modules/self-learning.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/modules/self-learning.js')>(
    '../../../src/modules/self-learning.js',
  );
  return {
    ...actual,
    SelfLearningModule: class extends actual.SelfLearningModule {
      constructor(...args: ConstructorParameters<typeof actual.SelfLearningModule>) {
        if ((args[0] as { botUserId?: string }).botUserId === 'force-throw') {
          throw new Error('forced ctor throw for T-1c');
        }
        super(...args);
      }
    },
  };
});

import { constructChatModule } from '../../../scripts/eval/replay-runner-core.js';
import { MockClaudeClient } from '../../../scripts/eval/mock-llm.js';
import { SelfLearningModule } from '../../../src/modules/self-learning.js';
import { buildSyntheticReplayDb } from '../../../scripts/eval/build-synthetic-replay-db.js';

const REPO = path.resolve(__dirname, '../../..');
// Dedicated synthetic fixture path for this file. Filename contains
// 'synthetic' so the constructChatModule tripwire is satisfied.
const FIXTURE_DB_SRC = path.join(
  REPO,
  'test/fixtures/replay-prod-db-synthetic-selflearning-wire.sqlite',
);

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `selflearning-wire-${prefix}-`));
}

function makeTmpDb(prefix: string): string {
  const dir = tmpDir(prefix);
  const dst = path.join(dir, 'synthetic.db');
  fs.copyFileSync(FIXTURE_DB_SRC, dst);
  return dst;
}

describe('replay-runner harness — selfLearning wire (T-1 / T-1b / T-1c)', () => {
  beforeAll(() => {
    // Build synthetic fixture once. Per-test rebuild races sibling parallel
    // test files that build other dedicated fixture paths.
    buildSyntheticReplayDb(FIXTURE_DB_SRC);
  });

  it('T-1: constructChatModule returns non-null selfLearning when ctor succeeds', () => {
    const tmpDb = makeTmpDb('t1');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    expect(result.chat).toBeDefined();
    expect(result.db).toBeDefined();
    expect(result.selfLearning).not.toBeNull();
  });

  it('T-1b: wired selfLearning is a SelfLearningModule instance', () => {
    const tmpDb = makeTmpDb('t1b');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    // SelfLearningModule symbol resolves to the mocked subclass (vi.mock
    // factory above), but the subclass extends the real class — instanceof
    // matches the mocked class which IS the SelfLearningModule for this
    // test file's module graph.
    expect(result.selfLearning).toBeInstanceOf(SelfLearningModule);
  });

  it('T-1c (edge): SelfLearningModule ctor throw -> result.selfLearning === null, harness still returns chat+db', () => {
    const tmpDb = makeTmpDb('t1c');
    const mockClaude = new MockClaudeClient();
    // Sentinel value triggers the mocked subclass constructor to throw.
    // Wire's try/catch must catch and fail-open with selfLearning = null.
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'force-throw',
      mockClaude,
    });
    expect(result.selfLearning).toBeNull();
    expect(result.chat).toBeDefined();
    expect(result.db).toBeDefined();
  });
});
