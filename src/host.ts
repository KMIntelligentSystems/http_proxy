import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const HOST_PORT = parseInt(process.env["HOST_PORT"] ?? "3000", 10);
const PROXY_URL = process.env["PROXY_URL"] ?? "http://localhost:8080";

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
    if (req.url === "/ui" || req.url === "/ui/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(UI_HTML);
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
