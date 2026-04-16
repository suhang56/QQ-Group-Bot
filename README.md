# QQ Group Bot

Intelligent QQ group bot powered by Claude AI. Features: casual chat participation, user style mimicry, automated moderation with appeal flow.

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite` module, which was added in v22.5.0 and is gated behind `--experimental-sqlite` on the v22 line — the npm scripts pass this flag automatically via `cross-env`)
- NapCat (QQ NT protocol, OneBot v11 WebSocket)
- Anthropic API key

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
```

## Run

```bash
# Development
npm run dev

# Production build
npm run build
npm start
```

## Test

```bash
npm test
npm run test:integration
```
