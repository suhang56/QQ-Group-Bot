import { describe, it, expect } from 'vitest';
import { R9_PLANNER_SYSTEM_PROMPT } from '../src/modules/reply-planner.js';

describe('R9_PLANNER_SYSTEM_PROMPT — R9.5 revival prompt addition', () => {
  it('T-9a: contains the new no-fact-hit-question positive bullet', () => {
    expect(R9_PLANNER_SYSTEM_PROMPT).toContain('当 has_real_fact_hit=false 且 trigger 是问句');
    expect(R9_PLANNER_SYSTEM_PROMPT).toContain('mode=reply，length_budget=normal');
    expect(R9_PLANNER_SYSTEM_PROMPT).toContain('群友被点名问问题时不会一字带过');
  });

  it('T-9b: pre-existing has_real_fact_hit=true bullet is unchanged', () => {
    expect(R9_PLANNER_SYSTEM_PROMPT).toContain(
      '- 当 has_real_fact_hit=true 且 trigger 是问句 → mode=fact_answer，required_fact_ids 至少 1 个',
    );
  });

  it('T-9c: pre-existing is_at=true → never silent bullet is unchanged', () => {
    expect(R9_PLANNER_SYSTEM_PROMPT).toContain(
      '- 当 is_at=true → 永远不要 silent（会被下游覆盖，浪费）',
    );
  });

  it('T-9d: 约束 list bullet count went 6 -> 7', () => {
    const lines = R9_PLANNER_SYSTEM_PROMPT.split('\n');
    const constraintIdx = lines.findIndex(l => l === '约束：');
    expect(constraintIdx).toBeGreaterThanOrEqual(0);
    const constraintBullets = lines
      .slice(constraintIdx + 1)
      .filter(line => line.startsWith('- '));
    expect(constraintBullets).toHaveLength(7);
  });
});
