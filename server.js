import http from "node:http";

const CONFIG = {
  port: Number.parseInt(process.env.PORT || "8080", 10),
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  defaultModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
  anthropicBase: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  anthropicVersion: "2023-06-01",
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : ["*"],
  bodyLimitBytes: 2 * 1024 * 1024,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: Number.parseInt(process.env.RATE_LIMIT || "30", 10),
  },
  maxTokensCap: {
    singleTurn: 4096,
    agentTurn: 8192,
  },
};

const hits = new Map();

function allowOrigin(origin) {
  if (!origin) return "*";
  if (CONFIG.allowedOrigins.includes("*")) return "*";
  return CONFIG.allowedOrigins.includes(origin) ? origin : "null";
}

function writeJson(res, status, data, origin = "*") {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowOrigin(origin),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > CONFIG.bodyLimitBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function rateLimit(req, origin, res) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > CONFIG.rateLimit.windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  hits.set(ip, entry);
  if (entry.count > CONFIG.rateLimit.maxRequests) {
    writeJson(
      res,
      429,
      { error: { type: "rate_limit", message: `Too many requests. Limit: ${CONFIG.rateLimit.maxRequests}/min.` } },
      origin,
    );
    return false;
  }
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - CONFIG.rateLimit.windowMs * 2;
  for (const [ip, entry] of hits.entries()) {
    if (entry.start < cutoff) hits.delete(ip);
  }
}, 300_000);

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));
}

function clampTokens(requested, cap) {
  const n = Number.parseInt(requested, 10);
  if (!n || n < 1) return Math.min(1000, cap);
  return Math.min(n, cap);
}

function extractText(data) {
  if (!Array.isArray(data?.content)) return "";
  return data.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("").trim();
}

async function anthropicFetch(payload) {
  const response = await fetch(`${CONFIG.anthropicBase}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.apiKey,
      "anthropic-version": CONFIG.anthropicVersion,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

const HOME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ClawdBot Mission Control API</title>
<style>body{font-family:system-ui;background:#06080c;color:#e4eaf4;margin:0;padding:24px}code{background:#151a28;padding:2px 6px;border-radius:6px}</style>
</head><body>
<h1>ClawdBot™ Mission Control API</h1>
<p>Server is running.</p>
<ul><li><code>GET /health</code></li><li><code>GET /api/health</code></li><li><code>POST /api/claude</code></li><li><code>POST /api/claude-agent</code></li></ul>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "*";
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": allowOrigin(origin),
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HOME_HTML);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, { ok: true, version: "4.2.1", model: CONFIG.defaultModel, timestamp: new Date().toISOString() }, origin);
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    writeJson(res, 200, { ok: true, version: "4.2.1" }, origin);
    return;
  }

  if (req.method === "POST" && (req.url === "/api/claude" || req.url === "/api/claude-agent")) {
    if (!rateLimit(req, origin, res)) return;
    if (!CONFIG.apiKey) {
      writeJson(res, 500, { error: { type: "config_error", message: "ANTHROPIC_API_KEY is not set." } }, origin);
      return;
    }

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      writeJson(res, 400, { error: { type: "validation", message: err.message } }, origin);
      return;
    }

    const { messages, model, max_tokens, system, tools } = body;
    const safeMessages = sanitizeMessages(messages);
    if (safeMessages.length === 0) {
      writeJson(res, 400, { error: { type: "validation", message: "messages array is required." } }, origin);
      return;
    }

    const isAgentRoute = req.url === "/api/claude-agent";
    const payload = {
      model: model || CONFIG.defaultModel,
      max_tokens: clampTokens(max_tokens, isAgentRoute ? CONFIG.maxTokensCap.agentTurn : CONFIG.maxTokensCap.singleTurn),
      messages: safeMessages,
    };
    if (system && typeof system === "string" && system.trim()) payload.system = system.trim();
    if (isAgentRoute && Array.isArray(tools) && tools.length > 0) payload.tools = tools;

    try {
      const { ok, status, data } = await anthropicFetch(payload);
      if (!ok) {
        writeJson(res, status, data, origin);
        return;
      }
      if (isAgentRoute) {
        writeJson(res, 200, data, origin);
        return;
      }
      writeJson(
        res,
        200,
        {
          text: extractText(data),
          model: data.model,
          usage: data.usage || null,
          stop_reason: data.stop_reason || null,
        },
        origin,
      );
      return;
    } catch (err) {
      writeJson(res, 500, { error: { type: "server_error", message: err.message } }, origin);
      return;
    }
  }

  writeJson(
    res,
    404,
    { error: { type: "not_found", message: "Route not found. Available: GET /health, POST /api/claude, POST /api/claude-agent" } },
    origin,
  );
});

server.listen(CONFIG.port, () => {
  const keyStatus = CONFIG.apiKey ? "set" : "MISSING";
  console.log(`ClawdBot API listening on :${CONFIG.port} (key ${keyStatus})`);
});
