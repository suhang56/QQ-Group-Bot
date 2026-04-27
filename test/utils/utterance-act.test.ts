import { describe, it, expect } from 'vitest';
import { ALL_UTTERANCE_ACTS, type UtteranceAct } from '../../src/utils/utterance-act.js';

describe('UtteranceAct enum', () => {
  it('has exactly the 8 acts', () => {
    expect(ALL_UTTERANCE_ACTS).toHaveLength(8);
    expect(new Set(ALL_UTTERANCE_ACTS)).toEqual(new Set([
      'direct_chat', 'chime_in', 'conflict_handle', 'summarize',
      'bot_status_query', 'relay', 'meta_admin_status', 'object_react',
    ]));
  });

  it('does NOT include keep_silent', () => {
    expect(ALL_UTTERANCE_ACTS as readonly string[]).not.toContain('keep_silent');
  });

  it('type-level: union covers all values (compile-only check)', () => {
    // If a value is removed from the union, this assertion fails to compile.
    const samples: UtteranceAct[] = [
      'direct_chat', 'chime_in', 'conflict_handle', 'summarize',
      'bot_status_query', 'relay', 'meta_admin_status', 'object_react',
    ];
    expect(samples).toHaveLength(8);
  });
});
