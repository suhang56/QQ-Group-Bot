# QQ Group Bot

Intelligent QQ group bot powered by Claude AI. Features: casual chat participation, user style mimicry, automated moderation with appeal flow.

## Requirements

- Node.js 22+
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
node dist/index.js
```

## Test

```bash
npm test
npm run test:integration
```
