/**
 * R6.3 — Deterministic mock Claude client.
 *
 * Implements IClaudeClient so ChatModule can be constructed with it as DI
 * seam (chat.ts:1056 ctor arg 1). All methods are sync-deterministic:
 *   - sha1(prompt).slice(0,8) → hex8 → appended after [mock:...] sentinel
 *   - zero usage tokens so any usage-branching code takes the zero path
 *   - `realNetworkCalls` is const 0 — tripwire for tests
 *
 * See DEV-READY §4, DESIGN-NOTE §3.
 */

import { createHash } from 'node:crypto';
import type {
  IClaudeClient,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeModel,
} from '../../src/ai/claude.js';

export interface MockCall {
  model: string;
  systemChars: number;
  msgChars: number;
}

export class MockClaudeClient implements IClaudeClient {
  callCount = 0;
  readonly calls: MockCall[] = [];
  readonly realNetworkCalls = 0;

  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    this.callCount++;
    const systemText = req.system.map(b => b.text).join('\n');
    const messagesText = req.messages.map(m => `${m.role}:${m.content}`).join('\n');
    const fullPrompt = systemText + '\n' + messagesText;
    const hex8 = createHash('sha1').update(fullPrompt).digest('hex').slice(0, 8);
    this.calls.push({
      model: String(req.model),
      systemChars: systemText.length,
      msgChars: messagesText.length,
    });
    return {
      text: `[mock:${hex8}] 好的`,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  async describeImage(_imageBytes: Buffer, _model: ClaudeModel): Promise<string> {
    this.callCount++;
    return '[mock-image] 一张图片';
  }

  async visionWithPrompt(
    _imageBytes: Buffer,
    _model: ClaudeModel,
    prompt: string,
    _maxTokens?: number,
  ): Promise<string> {
    this.callCount++;
    const hex8 = createHash('sha1').update(prompt).digest('hex').slice(0, 8);
    return `[mock-vision:${hex8}] 看起来是一张图`;
  }
}
