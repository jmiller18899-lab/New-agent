import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

const KEY = process.env.ANTHROPIC_API_KEY || "";

async function claude(body) {
const r = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
body: JSON.stringify(body),
});
return { ok: r.ok, status: r.status, data: await r.json() };
}

app.get("/health", (*, res) => res.json({ ok: true }));
app.get("/api/health", (*, res) => res.json({ ok: true }));

app.post("/api/claude", async (req, res) => {
try {
if (!KEY) return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY not set" } });
const { system, messages, model, max_tokens } = req.body;
const payload = { model: model || "claude-sonnet-4-20250514", max_tokens: max_tokens || 1000, messages: messages || [] };
if (system) payload.system = system;
const { ok, status, data } = await claude(payload);
if (!ok) return res.status(status).json(data);
const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
res.json({ text, usage: data.usage || null });
} catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.post("/api/claude-agent", async (req, res) => {
try {
if (!KEY) return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY not set" } });
const { messages, model, max_tokens, system, tools } = req.body;
const payload = { model: model || "claude-sonnet-4-20250514", max_tokens: max_tokens || 2000, messages: messages || [] };
if (system) payload.system = system;
if (tools?.length) payload.tools = tools;
const { ok, status, data } = await claude(payload);
if (!ok) return res.status(status).json(data);
res.json(data);
} catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ClawdBot API on :${port} (key ${KEY ? "set" : "MISSING"})`))