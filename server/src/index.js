import "dotenv/config";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { initDb } from "./db.js";
import { setupWebSocket } from "./websocket.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

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
