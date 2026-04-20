#!/usr/bin/env tsx
/**
 * R6.2 — gold-label CLI.
 *
 * Usage:
 *   npx tsx scripts/eval/label-gold.ts \
 *     --input data/eval/r6-1c/benchmark-weak-labeled.jsonl \
 *     --output data/eval/gold/gold-500.jsonl \
 *     [--limit 500]
 *
 * Interactive only — requires TTY stdin. Does not import `src/` (no runtime
 * bot code); zero LLM / DB / generateReply calls.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { countSamples } from './gold/reader.js';
import { runSession } from './gold/session.js';

interface ParsedArgs {
  input: string;
  output: string;
  limit?: number;
}

function usage(): never {
  process.stderr.write(
    'Usage: tsx scripts/eval/label-gold.ts --input <path> --output <path> [--limit <N>]\n',
  );
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  let input: string | undefined;
  let output: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      input = argv[++i];
    } else if (a === '--output') {
      output = argv[++i];
    } else if (a === '--limit') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write('--limit must be a positive integer\n');
        process.exit(1);
      }
      limit = n;
    } else if (a === '--help' || a === '-h') {
      usage();
    } else {
      process.stderr.write(`Unknown arg: ${a}\n`);
      usage();
    }
  }
  if (!input || !output) usage();
  return limit === undefined ? { input, output } : { input, output, limit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.stdin.isTTY) {
    process.stderr.write('Error: stdin must be a TTY (interactive terminal).\n');
    process.exit(1);
  }

  try {
    await fsp.access(args.input);
  } catch {
    process.stderr.write(`Error: input file not readable: ${args.input}\n`);
    process.exit(1);
  }

  await fsp.mkdir(path.dirname(args.output), { recursive: true });

  const total = typeof args.limit === 'number' ? args.limit : await countSamples(args.input);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  // Raw-mode data events arrive as Buffer by default (no encoding set).

  const restoreStdin = (): void => {
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch { /* already closed */ }
  };

  const onSigint = (): void => {
    restoreStdin();
    process.stdout.write('\n[aborted]\n');
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  const readKey = (): Promise<Buffer> => new Promise(resolve => {
    const handler = (chunk: Buffer | string): void => {
      process.stdin.off('data', handler);
      resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    process.stdin.on('data', handler);
  });

  const promptNotesLine = (): Promise<string> => new Promise(resolve => {
    process.stdin.setRawMode(false);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('  Enter notes (max 500 chars, Enter to confirm): ');
    rl.once('line', line => {
      rl.close();
      process.stdin.setRawMode(true);
      resolve(line);
    });
  });

  try {
    await runSession({
      inputPath: args.input,
      outputPath: args.output,
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      total,
      readKey,
      promptNotesLine,
    });
  } finally {
    process.off('SIGINT', onSigint);
    restoreStdin();
  }

  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? String(err)}\n`);
  try { process.stdin.setRawMode(false); } catch { /* */ }
  process.exit(1);
});
