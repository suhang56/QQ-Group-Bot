import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// Mock @xenova/transformers before importing the embedder
vi.mock('@xenova/transformers', () => {
  const mockPipeline = vi.fn();
  return {
    pipeline: mockPipeline,
  };
});

describe('EmbeddingService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('embed() returns a number array of correct dimension (384)', async () => {
    const { pipeline } = await import('@xenova/transformers');
    const fakeOutput = { data: new Float32Array(384).fill(0.1) };
    vi.mocked(pipeline).mockResolvedValue(vi.fn().mockResolvedValue(fakeOutput) as never);

    const { EmbeddingService } = await import('../src/storage/embeddings.js');
    const svc = new EmbeddingService();
    await svc.waitReady();
    const result = await svc.embed('hello world');
    expect(result).toHaveLength(384);
    // After normalisation: each element = 0.1 / sqrt(384 * 0.01) ≈ 0.051
    const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('embed() normalises the vector (unit length)', async () => {
    const { pipeline } = await import('@xenova/transformers');
    // Unnormalized: [3, 4] → normalized: [0.6, 0.8]
    const raw = new Float32Array(384);
    raw[0] = 3;
    raw[1] = 4;
    vi.mocked(pipeline).mockResolvedValue(vi.fn().mockResolvedValue({ data: raw }) as never);

    const { EmbeddingService } = await import('../src/storage/embeddings.js');
    const svc = new EmbeddingService();
    await svc.waitReady();
    const result = await svc.embed('test');
    const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('model is loaded only once across multiple embed() calls (singleton cache)', async () => {
    const { pipeline } = await import('@xenova/transformers');
    const mockFn = vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.5) });
    vi.mocked(pipeline).mockResolvedValue(mockFn as never);

    const { EmbeddingService } = await import('../src/storage/embeddings.js');
    const svc = new EmbeddingService();
    await svc.waitReady();
    await svc.embed('first');
    await svc.embed('second');
    await svc.embed('third');
    // pipeline() called once, inner model called 3 times
    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(1);
  });

  it('embed() before waitReady() still resolves (lazy init race)', async () => {
    const { pipeline } = await import('@xenova/transformers');
    vi.mocked(pipeline).mockResolvedValue(vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.2) }) as never);

    const { EmbeddingService } = await import('../src/storage/embeddings.js');
    const svc = new EmbeddingService(); // do NOT await waitReady
    // embed() should internally await the load promise
    const result = await svc.embed('concurrent call');
    expect(result).toHaveLength(384);
  });

  it('isReady returns false before load completes and true after', async () => {
    const { pipeline } = await import('@xenova/transformers');
    let resolvePipeline!: (v: unknown) => void;
    const pipelinePromise = new Promise(r => { resolvePipeline = r; });
    vi.mocked(pipeline).mockReturnValue(pipelinePromise as never);

    const { EmbeddingService } = await import('../src/storage/embeddings.js');
    const svc = new EmbeddingService();
    expect(svc.isReady).toBe(false);
    const mockFn = vi.fn().mockResolvedValue({ data: new Float32Array(384) });
    resolvePipeline(mockFn);
    await svc.waitReady();
    expect(svc.isReady).toBe(true);
  });

  it('model load failure sets disabled state and subsequent embed calls throw', async () => {
    const { pipeline } = await import('@xenova/transformers');
    vi.mocked(pipeline).mockRejectedValue(new Error('network error'));

    const { EmbeddingService } = await import('../src/storage/embeddings.js');
    const svc = new EmbeddingService();
    // waitReady resolves (not throws) but marks service as disabled
    await svc.waitReady();
    expect(svc.isReady).toBe(false);
    await expect(svc.embed('test')).rejects.toThrow('EmbeddingService disabled');
  });
});

describe('cosine similarity helper', () => {
  it('identical vectors → similarity 1.0', async () => {
    const { cosineSimilarity } = await import('../src/storage/embeddings.js');
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('orthogonal vectors → similarity 0', async () => {
    const { cosineSimilarity } = await import('../src/storage/embeddings.js');
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('opposite vectors → similarity -1', async () => {
    const { cosineSimilarity } = await import('../src/storage/embeddings.js');
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('zero vector → returns 0 (no NaN)', async () => {
    const { cosineSimilarity } = await import('../src/storage/embeddings.js');
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });
});
