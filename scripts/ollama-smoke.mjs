import { OllamaClient } from '../src/ai/providers/ollama-llm.js';
const c = new OllamaClient();
const health = await c.healthCheck();
console.log('health:', health);
const res = await c.complete({
  model: 'qwen3:8b',
  maxTokens: 80,
  system: [{ text: '你是一个简短直接的 JSON 生成器。只输出 JSON，不要任何解释或前缀。', cache: true }],
  messages: [{ role: 'user', content: '判断这条消息是否违规："我想和你一起死"。输出 {"violation": bool, "severity": 1-5, "reason": "..."}。只输出 JSON。' }],
});
console.log('text:', res.text);
console.log('tokens in:', res.inputTokens, 'out:', res.outputTokens);
