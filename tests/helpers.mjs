import http from "node:http";

/**
 * @param {{
 * services?: Array<{id: string; docsUrl?: string}>;
 * docsByServiceId?: Record<string, string>;
 * handlers?: Record<string, (req: import('node:http').IncomingMessage, body: any) => any>;
 * }} [config]
 */
export async function startMockOttoauth(config = {}) {
  const services = config.services ?? [
    { id: "amazon" },
    { id: "computeruse" },
  ];

  const docsByServiceId = config.docsByServiceId ?? {
    amazon: `# Amazon\n\n\
\`\`\`bash
POST /api/services/amazon/buy
\`\`\`\n\n\
\`\`\`bash
curl -s -X POST /api/services/amazon/history -d '{}'
\`\`\``,
    computeruse: `# Computeruse\n\n\
\`\`\`bash
curl -X POST /api/computeruse/runs/RUN_ID_HERE/events
\`\`\``,
  };

  const handlers = {
    "POST /api/services/amazon/buy": (_req, body) => ({ ok: true, endpoint: "buy", body }),
    "POST /api/services/amazon/history": (_req, body) => ({ ok: true, endpoint: "history", body }),
    "POST /api/computeruse/runs/:run_id/events": (_req, body) => ({ ok: true, endpoint: "events", body }),
    ...(config.handlers ?? {}),
  };

  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = req.method || "GET";

    const body = await new Promise((resolve) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        if (!raw) return resolve(null);
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      });
    });

    requests.push({ method, path: url.pathname, query: url.searchParams.toString(), body, headers: req.headers });

    if (method === "GET" && url.pathname === "/api/services") {
      const base = `http://127.0.0.1:${server.address().port}`;
      const payload = {
        services: services.map((svc) => ({
          id: svc.id,
          docsUrl: svc.docsUrl || `${base}/api/services/${svc.id}`,
        })),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/api/services/")) {
      const serviceId = url.pathname.split("/").at(-1);
      const docs = docsByServiceId[serviceId] ?? "";
      if (!docs) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(docs);
      return;
    }

    const exact = `${method} ${url.pathname}`;
    const hasEventsPath = method === "POST" && /^\/api\/computeruse\/runs\/[^/]+\/events$/.test(url.pathname);
    const key = hasEventsPath ? "POST /api/computeruse/runs/:run_id/events" : exact;
    const handler = handlers[key];

    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-found", path: url.pathname, method }));
      return;
    }

    const out = handler(req, body);
    if (typeof out === "string") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(out);
      return;
    }

    if (out && out.__status) {
      res.writeHead(out.__status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body ?? null));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out ?? {}));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
