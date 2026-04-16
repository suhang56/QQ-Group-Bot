import { createLogger } from '../utils/logger.js';

const logger = createLogger('embeddings');

export interface IEmbeddingService {
  readonly isReady: boolean;
  embed(text: string): Promise<number[]>;
  waitReady(): Promise<void>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function normalise(vec: Float32Array): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(vec);
  return Array.from(vec, v => v / norm);
}

const DEFAULT_LRU_CAP = 2000;

export class EmbeddingService implements IEmbeddingService {
  private _ready = false;
  private _disabled = false;
  private _model: ((text: string, opts: object) => Promise<{ data: Float32Array }>) | null = null;
  private readonly _loadPromise: Promise<void>;
  // LRU cache: text -> embedding vector. Uses Map insertion order for LRU eviction.
  private readonly _cache = new Map<string, number[]>();
  private readonly _lruCap: number;

  constructor(modelName = 'Xenova/all-MiniLM-L6-v2', lruCap = DEFAULT_LRU_CAP) {
    this._lruCap = lruCap;
    this._loadPromise = this._load(modelName);
  }

  get isReady(): boolean { return this._ready; }

  async waitReady(): Promise<void> {
    await this._loadPromise;
  }

  async embed(text: string): Promise<number[]> {
    // LRU cache hit: move to end (most recently used)
    const cached = this._cache.get(text);
    if (cached) {
      this._cache.delete(text);
      this._cache.set(text, cached);
      return cached;
    }

    await this._loadPromise;
    if (this._disabled || !this._model) {
      throw new Error('EmbeddingService disabled — model failed to load');
    }
    const output = await this._model(text, { pooling: 'mean', normalize: false });
    const vec = normalise(output.data);

    // Evict oldest if over capacity
    if (this._cache.size >= this._lruCap) {
      const oldest = this._cache.keys().next().value;
      if (oldest !== undefined) this._cache.delete(oldest);
    }
    this._cache.set(text, vec);
    return vec;
  }

  /** Pre-populate cache from stored embeddings (e.g. BLOB from DB). */
  preload(text: string, vec: number[]): void {
    if (this._cache.size >= this._lruCap) {
      const oldest = this._cache.keys().next().value;
      if (oldest !== undefined) this._cache.delete(oldest);
    }
    this._cache.set(text, vec);
  }

  private async _load(modelName: string): Promise<void> {
    try {
      const { pipeline } = await import('@xenova/transformers');
      this._model = await pipeline('feature-extraction', modelName) as typeof this._model;
      this._ready = true;
      logger.info({ modelName }, 'Embedding model loaded');
    } catch (err) {
      this._disabled = true;
      logger.warn({ err, modelName }, 'Embedding model failed to load — learner RAG disabled');
    }
  }
}
