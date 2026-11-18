/**
 * Optional production-hardened HTTP healthcheck and status server for Cypher agent.
 * Designed to satisfy OWASP Top 10 and pass OWASP ZAP automated baseline scans.
 */
import * as http from "http";

export interface HealthServerOptions {
  port: number;
  host?: string;
  getStatus: () => {
    healthy: boolean;
    uptimeSeconds: number;
    cluster: string;
    lastTickTimestamp?: number;
  };
}

export function startHealthServer(options: HealthServerOptions): http.Server {
  const host = options.host || "127.0.0.1";

  const server = http.createServer((req, res) => {
    // 1. Strict Security Headers (OWASP ZAP Compliance)
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.removeHeader("X-Powered-By");

    // 2. HTTP Method restriction (GET only)
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    // 3. Path Routing
    const url = req.url?.split("?")[0];
    if (url === "/healthz" || url === "/health" || url === "/") {
      const status = options.getStatus();
      const statusCode = status.healthy ? 200 : 503;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: status.healthy ? "ok" : "degraded",
          uptime: status.uptimeSeconds,
          cluster: status.cluster,
          lastTick: status.lastTickTimestamp || null,
        })
      );
      return;
    }

    // 4. Default 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  server.listen(options.port, host, () => {
    console.log(`[agent] healthcheck server listening on http://${host}:${options.port}/healthz`);
  });

  return server;
}

