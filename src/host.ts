import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const HOST_PORT = parseInt(process.env["HOST_PORT"] ?? "3000", 10);
const PROXY_URL = process.env["PROXY_URL"] ?? "http://localhost:8080";

// Load BLS API key from data/.env
let BLS_API_KEY = "";
try {
  const envPath = path.resolve(import.meta.dirname ?? ".", "..", "data", ".env");
  const envText = fs.readFileSync(envPath, "utf-8");
  const match = envText.match(/^BLS_API_KEY=(.+)$/m);
  if (match) BLS_API_KEY = match[1].trim().replace(/["']/g, "");
  if (BLS_API_KEY) console.log(`[host] BLS API key loaded (${BLS_API_KEY.slice(0, 6)}…)`);
  else console.warn(`[host] BLS_API_KEY not found in ${envPath}`);
} catch (e) {
  console.warn(`[host] Could not read data/.env for BLS key`);
}

// Browser WS clients connected to /ui/ws — receives SVG push messages
const browserClients = new Set<WebSocket>();

// Broadcast an SVG command to all browser clients
export function broadcastSvg(msg: SvgMessage) {
  const payload = JSON.stringify(msg);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export type SvgMessage =
  | { type: "clear" }
  | { type: "append"; svg: string }
  | { type: "replace"; id: string; svg: string }
  | { type: "remove"; id: string };

// ─── HTML shell served at /ui ────────────────────────────────────────────────

const UI_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>http-proxy canvas</title>
  <style>
    body { margin: 0; background: #0d1117; display: flex; justify-content: center; align-items: center; height: 100vh; }
    svg  { background: #161b22; border: 1px solid #30363d; border-radius: 6px; }
  </style>
</head>
<body>
  <svg id="canvas" width="800" height="600" xmlns="http://www.w3.org/2000/svg"></svg>
  <script>
    const canvas = document.getElementById("canvas");
    const wsUrl  = "ws://" + location.host + "/ui/ws";
    let   ws;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "clear") {
          canvas.innerHTML = "";
        } else if (msg.type === "append") {
          canvas.insertAdjacentHTML("beforeend", msg.svg);
        } else if (msg.type === "replace") {
          const el = document.getElementById(msg.id);
          if (el) el.outerHTML = msg.svg;
          else canvas.insertAdjacentHTML("beforeend", msg.svg);
        } else if (msg.type === "remove") {
          document.getElementById(msg.id)?.remove();
        }
      };

      ws.onclose = () => setTimeout(connect, 1500); // auto-reconnect
    }

    connect();
  </script>
</body>
</html>`;

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Requests tagged x-loopback arrived via proxy — serve real content
  if (req.headers["x-loopback"] === "1") {
    // OEWS drilldown UI
    if (req.url === "/ui" || req.url === "/ui/") {
      const uiPath = path.resolve(import.meta.dirname ?? ".", "..", "src", "ui", "oe-drilldown.html");
      try {
        const html = fs.readFileSync(uiPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        // Fallback to SVG canvas
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(UI_HTML);
      }
      return;
    }

    // Serve data files under /ui/data/*
    if (req.url?.startsWith("/ui/data/")) {
      const fileName = req.url.replace("/ui/data/", "");
      const filePath = path.resolve(import.meta.dirname ?? ".", "..", "dist", fileName);
      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(fileName);
        const ct = ext === ".json" ? "application/json" : ext === ".csv" ? "text/csv" : "application/octet-stream";
        res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public, max-age=3600" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Data file not found");
      }
      return;
    }

    // Legacy SVG canvas at /ui/canvas
    if (req.url === "/ui/canvas") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(UI_HTML);
      return;
    }

    // POST /ui/api/bls — proxy BLS API requests to avoid CORS
    if (req.url === "/ui/api/bls" && req.method === "POST") {
      const body: Buffer[] = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", () => {
        let parsed: any = {};
        try { parsed = JSON.parse(Buffer.concat(body).toString()); } catch {}
        // Inject API key if available and not already provided
        if (BLS_API_KEY && !parsed.registrationkey) {
          parsed.registrationkey = BLS_API_KEY;
        }
        const payload = Buffer.from(JSON.stringify(parsed));
        const blsReq = https.request(
          {
            hostname: "api.bls.gov",
            path: "/publicAPI/v2/timeseries/data/",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": payload.length,
            },
          },
          (blsRes) => {
            const chunks: Buffer[] = [];
            blsRes.on("data", (c) => chunks.push(c));
            blsRes.on("end", () => {
              const result = Buffer.concat(chunks);
              res.writeHead(blsRes.statusCode ?? 200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(result);
            });
          }
        );
        blsReq.on("error", (err) => {
          console.error(`[bls proxy error] ${err.message}`);
          res.writeHead(502);
          res.end(JSON.stringify({ status: "REQUEST_FAILED", message: [err.message] }));
        });
        blsReq.write(payload);
        blsReq.end();
      });
      return;
    }

    // POST /ui/svg — TUI or any local process can push SVG messages here
    if (req.url === "/ui/svg" && req.method === "POST") {
      const body: Buffer[] = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", () => {
        try {
          const msg: SvgMessage = JSON.parse(Buffer.concat(body).toString());
          broadcastSvg(msg);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end("Bad JSON");
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // First hop — forward through the proxy (loopback)
  const body: Buffer[] = [];
  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    const proxyUrl = new URL(req.url ?? "/", PROXY_URL);
    const outReq = http.request(
      {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: proxyUrl.pathname + proxyUrl.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: proxyUrl.host,
          "x-loopback": "1",
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    outReq.on("error", (err) => {
      console.error(`[loopback error] ${err.message}`);
      res.writeHead(502);
      res.end("Loopback error");
    });

    if (body.length) outReq.write(Buffer.concat(body));
    outReq.end();
  });
});

// ─── WebSocket server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on("connection", (clientSocket, req) => {
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`[${new Date().toISOString()}] WS ${clientId} ${req.url}`);

  // /ui/ws — browser SVG canvas client
  if (req.url === "/ui/ws") {
    browserClients.add(clientSocket);
    clientSocket.on("close", () => browserClients.delete(clientSocket));
    return;
  }

  // Loopback echo (proxy health / internal)
  if (req.headers["x-loopback"] === "1") {
    clientSocket.on("message", (data, isBinary) => clientSocket.send(data, { binary: isBinary }));
    return;
  }

  // All other WS — forward through the proxy
  const wsProxyUrl = PROXY_URL.replace(/^http/, "ws");
  const loopSocket = new WebSocket(`${wsProxyUrl}${req.url ?? "/"}`, {
    headers: { "x-loopback": "1" },
  });

  clientSocket.on("message", (data, isBinary) => {
    if (loopSocket.readyState === WebSocket.OPEN) loopSocket.send(data, { binary: isBinary });
  });
  loopSocket.on("message", (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data, { binary: isBinary });
  });

  clientSocket.on("close", (code, reason) => loopSocket.close(code, reason));
  loopSocket.on("close", (code, reason) => clientSocket.close(code, reason));

  loopSocket.on("error", (err) => {
    console.error(`[${clientId}] loopback WS error: ${err.message}`);
    clientSocket.close(1011, "Loopback error");
  });
});

server.listen(HOST_PORT, "127.0.0.1", () => {
  console.log(`Host listening on http://127.0.0.1:${HOST_PORT}`);
  console.log(`SVG canvas at  http://127.0.0.1:8080/ui`);
  console.log(`SVG push API   POST http://127.0.0.1:8080/ui/svg`);
});
