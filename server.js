import express from "express";
import cors from "cors";

const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 8080,
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  defaultModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
  anthropicBase: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  anthropicVersion: "2023-06-01",
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : true,
  bodyLimit: process.env.BODY_LIMIT || "2mb",
  rateLimit: {
    windowMs: 60_000,
    maxRequests: parseInt(process.env.RATE_LIMIT, 10) || 30,
  },
  maxTokensCap: {
    singleTurn: 4096,
    agentTurn: 8192,
  },
};

const app = express();
app.use(
  cors({
    origin: CONFIG.allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
app.use(express.json({ limit: CONFIG.bodyLimit }));

app.use((req, _res, next) => {
  if (req.method !== "OPTIONS") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > CONFIG.rateLimit.windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  hits.set(ip, entry);
  if (entry.count > CONFIG.rateLimit.maxRequests) {
    return res.status(429).json({
      error: {
        type: "rate_limit",
        message: `Too many requests. Limit: ${CONFIG.rateLimit.maxRequests}/min. Try again shortly.`,
      },
    });
  }
  return next();
}

setInterval(() => {
  const cutoff = Date.now() - CONFIG.rateLimit.windowMs * 2;
  for (const [ip, entry] of hits.entries()) {
    if (entry.start < cutoff) hits.delete(ip);
  }
}, 300_000);

function requireKey(res) {
  if (!CONFIG.apiKey) {
    res.status(500).json({
      error: {
        type: "config_error",
        message: "ANTHROPIC_API_KEY is not set. Add it to your environment variables.",
      },
    });
    return false;
  }
  return true;
}

function clampTokens(requested, cap) {
  const n = parseInt(requested, 10);
  if (!n || n < 1) return Math.min(1000, cap);
  return Math.min(n, cap);
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
}

async function anthropicFetch(body) {
  const res = await fetch(`${CONFIG.anthropicBase}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.apiKey,
      "anthropic-version": CONFIG.anthropicVersion,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

function extractText(data) {
  if (!data?.content || !Array.isArray(data.content)) return "";
  return data.content
    .filter((b) => b?.type === "text")
    .map((b) => b.text || "")
    .join("")
    .trim();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: "4.2.0", model: CONFIG.defaultModel, timestamp: new Date().toISOString() });
});
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: "4.2.0" });
});

app.post("/api/claude", rateLimit, async (req, res) => {
  try {
    if (!requireKey(res)) return;
    const { system, messages, model, max_tokens } = req.body;
    const safeMessages = sanitizeMessages(messages);
    if (safeMessages.length === 0) {
      return res.status(400).json({ error: { type: "validation", message: "messages array is required and must contain at least one message." } });
    }
    const payload = {
      model: model || CONFIG.defaultModel,
      max_tokens: clampTokens(max_tokens, CONFIG.maxTokensCap.singleTurn),
      messages: safeMessages,
    };
    if (system && typeof system === "string" && system.trim()) payload.system = system.trim();

    const { ok, status, data } = await anthropicFetch(payload);
    if (!ok) return res.status(status).json(data);

    return res.json({
      text: extractText(data),
      model: data.model,
      usage: data.usage || null,
      stop_reason: data.stop_reason || null,
    });
  } catch (err) {
    console.error("[/api/claude] Unhandled:", err.message);
    return res.status(500).json({ error: { type: "server_error", message: err.message } });
  }
});

app.post("/api/claude-agent", rateLimit, async (req, res) => {
  try {
    if (!requireKey(res)) return;
    const { messages, model, max_tokens, system, tools } = req.body;
    const safeMessages = sanitizeMessages(messages);
    if (safeMessages.length === 0) {
      return res.status(400).json({ error: { type: "validation", message: "messages array is required." } });
    }
    const payload = {
      model: model || CONFIG.defaultModel,
      max_tokens: clampTokens(max_tokens, CONFIG.maxTokensCap.agentTurn),
      messages: safeMessages,
    };
    if (system && typeof system === "string" && system.trim()) payload.system = system.trim();
    if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;

    const { ok, status, data } = await anthropicFetch(payload);
    if (!ok) return res.status(status).json(data);
    return res.json(data);
  } catch (err) {
    console.error("[/api/claude-agent] Unhandled:", err.message);
    return res.status(500).json({ error: { type: "server_error", message: err.message } });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    error: {
      type: "not_found",
      message: "Route not found. Available: GET /health, POST /api/claude, POST /api/claude-agent",
    },
  });
});

app.listen(CONFIG.port, () => {
  const keyStatus = CONFIG.apiKey ? "set" : "MISSING";
  console.log(`ClawdBot API listening on :${CONFIG.port} (key ${keyStatus})`);
});
