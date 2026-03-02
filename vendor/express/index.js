import http from "node:http";

function createApp() {
  const middlewares = [];
  const routes = [];

  const app = {
    use(fn) { middlewares.push(fn); },
    get(path, handler) { routes.push({ method: "GET", path, handler }); },
    post(path, handler) { routes.push({ method: "POST", path, handler }); },
    listen(port, cb) {
      const server = http.createServer((req, res) => {
        res.status = (code) => {
          res.statusCode = code;
          return res;
        };
        res.json = (data) => {
          if (!res.headersSent) res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(data));
          return res;
        };

        const stack = [...middlewares];
        const route = routes.find((r) => r.method === req.method && r.path === req.url);
        stack.push(route ? route.handler : (_req, routeRes) => routeRes.status(404).json({ error: { message: "Not found" } }));

        let i = 0;
        const next = (err) => {
          if (err) {
            if (!res.writableEnded) res.status(500).json({ error: { message: err.message || "Internal error" } });
            return;
          }
          const fn = stack[i++];
          if (!fn || res.writableEnded) return;
          try {
            if (fn.length >= 3) fn(req, res, next);
            else Promise.resolve(fn(req, res)).catch(next);
          } catch (e) {
            next(e);
          }
        };

        next();
      });
      return server.listen(port, cb);
    },
  };

  return app;
}

function parseLimit(limit = "100kb") {
  const m = String(limit).trim().match(/^(\d+)(kb|mb|b)?$/i);
  if (!m) return 100 * 1024;
  const n = Number.parseInt(m[1], 10);
  const unit = (m[2] || "b").toLowerCase();
  return unit === "mb" ? n * 1024 * 1024 : unit === "kb" ? n * 1024 : n;
}

createApp.json = (options = {}) => {
  const limit = parseLimit(options.limit || "100kb");
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      req.body = {};
      next();
      return;
    }
    const ctype = req.headers["content-type"] || "";
    if (!ctype.includes("application/json")) {
      req.body = {};
      next();
      return;
    }

    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.status(413).json({ error: { message: "Payload too large" } });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      if (chunks.length === 0) {
        req.body = {};
        next();
        return;
      }
      try {
        req.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        next();
      } catch {
        res.status(400).json({ error: { message: "Invalid JSON" } });
      }
    });
    req.on("error", next);
  };
};

export default createApp;
