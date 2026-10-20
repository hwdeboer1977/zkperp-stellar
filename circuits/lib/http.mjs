// Tiny JSON / Prometheus HTTP helpers for the service servers (steps 14-15).
import http from "node:http";

/** Serves `routes` ({ "GET /path": (req, match) => body }) on host:port; bodies are JSON unless a string. */
export function serve({ host = "127.0.0.1", port, routes, log }) {
  const server = http.createServer(async (req, res) => {
    for (const [key, handler] of Object.entries(routes)) {
      const [method, pattern] = key.split(" ");
      const m = req.method === method && req.url.match(new RegExp(`^${pattern}$`));
      if (!m) continue;
      try {
        const body = await handler(req, m);
        if (body === undefined) break;
        const text = typeof body === "string";
        res.writeHead(200, { "content-type": text ? "text/plain; version=0.0.4" : "application/json" });
        res.end(text ? body : JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", routes: Object.keys(routes) }));
  });
  server.listen(port, host, () => log?.(`listening on http://${host}:${port}`));
  return server;
}

/** Prometheus text format from { name: [help, value] }. */
export const metrics = (prefix, values) =>
  Object.entries(values).filter(([, [, v]]) => v !== null && v !== undefined)
    .map(([k, [help, v]]) => `# HELP ${prefix}_${k} ${help}\n# TYPE ${prefix}_${k} gauge\n${prefix}_${k} ${Number(v)}`).join("\n") + "\n";
