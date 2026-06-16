import "dotenv/config";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { initDb } from "./db.js";
import { setupWebSocket } from "./websocket.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Trust the X-Forwarded-For header set by Nginx so rate limits apply per
// real client IP, not the proxy's IP (which would be the same for everyone).
app.set("trust proxy", 1);

// Limit each IP to 60 HTTP requests per minute (static files, health check).
// WebSocket traffic is not HTTP so it's handled separately in websocket.js.
app.use(rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
}));

// Health-check — useful when you later run multiple server instances
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Serve the static client (index.html / style.css / app.js) on the same
// port as the WebSocket, so one container exposes the whole app.
const CLIENT_DIR = process.env.CLIENT_DIR || path.resolve(__dirname, "../../client");
app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);

setupWebSocket(server);

const PORT = process.env.PORT ?? 3001;

async function start() {
  await initDb();
  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] WebSocket ready on ws://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
