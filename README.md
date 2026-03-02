# ClawdBot Mission Control

Secure Express proxy between a React frontend and Anthropic's Claude API.

## Quick start

```bash
npm install
cp .env.example .env
# set ANTHROPIC_API_KEY in .env
npm run dev:api
```

In another terminal:

```bash
npm run dev:web
```

## Docker

```bash
cp .env.example .env
# set ANTHROPIC_API_KEY in .env
docker compose up --build
```

API health: `http://localhost:8080/health`

## Environment variables

See `.env.example` for all settings.
