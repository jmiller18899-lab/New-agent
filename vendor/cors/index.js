export default function cors(options = {}) {
  return (req, res, next) => {
    const requestOrigin = req.headers.origin;
    const allowOrigin = options.origin === true ? (requestOrigin || "*") : (options.origin || "*");
    res.setHeader("access-control-allow-origin", allowOrigin);
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}
