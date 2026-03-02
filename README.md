# ClawdBot Mission Control

Secure Anthropic proxy API server with zero external runtime dependencies.

## Quick start

```bash
npm install
cp .env.example .env
# set ANTHROPIC_API_KEY in .env
npm start
```

Server runs at `http://localhost:8080`.

## Docker

```bash
cp .env.example .env
# set ANTHROPIC_API_KEY in .env
docker compose up --build
```

## Endpoints

- `GET /`
- `GET /health`
- `GET /api/health`
- `POST /api/claude`
- `POST /api/claude-agent`

## Environment variables

See `.env.example`.
