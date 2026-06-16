import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import { pub, sub, setPresence, removePresence, getPresence, refreshPresence } from "./redis.js";
import { saveMessage, getHistory } from "./db.js";
import { verifyToken } from "./auth.js";

const CHANNEL = "chat:messages";

// Simple token-bucket rate limiter per WebSocket connection.
// Allows a burst of up to MAX_TOKENS messages, then 1 message per REFILL_MS.
const MAX_TOKENS  = 10;
const REFILL_MS   = 1000;

function makeRateLimiter() {
  let tokens = MAX_TOKENS;
  let lastRefill = Date.now();
  return function allow() {
    const now = Date.now();
    const gained = Math.floor((now - lastRefill) / REFILL_MS);
    if (gained > 0) {
      tokens = Math.min(MAX_TOKENS, tokens + gained);
      lastRefill = now;
    }
    if (tokens <= 0) return false;
    tokens--;
    return true;
  };
}

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  // Local map: userId → { ws, room, username, allow }
  const clients = new Map();

  // ── Subscribe to Redis ────────────────────────────────────────────────────
  // Every message published to CHANNEL arrives here and gets fanned out to
  // any local WebSocket clients in the relevant room.
  sub.subscribe(CHANNEL, (err) => {
    if (err) console.error("[redis] subscribe error", err);
    else console.log(`[redis] subscribed to ${CHANNEL}`);
  });

  sub.on("message", (_channel, raw) => {
    const msg = JSON.parse(raw);
    for (const [, client] of clients) {
      if (client.room === msg.room && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify({ type: "message", payload: msg }));
      }
    }
  });

  // ── Connection handler ────────────────────────────────────────────────────
  wss.on("connection", (ws) => {
    const userId = uuidv4();
    const allow  = makeRateLimiter();
    clients.set(userId, { ws, room: null, username: null, allow });
    console.log(`[ws] client connected  userId=${userId}`);

    ws.on("message", async (raw) => {
      if (!allow()) {
        ws.send(JSON.stringify({ type: "error", payload: "Rate limit exceeded. Slow down." }));
        return;
      }

      let packet;
      try {
        packet = JSON.parse(raw);
      } catch {
        return;
      }

      switch (packet.type) {
        case "join":
          await handleJoin(userId, packet, ws);
          break;
        case "message":
          await handleMessage(userId, packet);
          break;
        case "heartbeat":
          await handleHeartbeat(userId);
          break;
        default:
          console.warn("[ws] unknown packet type:", packet.type);
      }
    });

    ws.on("close", () => handleDisconnect(userId));
    ws.on("error", (err) => console.error(`[ws] error userId=${userId}`, err));
  });

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleJoin(userId, packet, ws) {
    // Verify JWT — username and room come from the signed token, not the client.
    // This prevents anyone from claiming another user's name.
    let claims;
    try {
      claims = verifyToken(packet.token);
    } catch {
      ws.send(JSON.stringify({ type: "error", payload: "Invalid or expired token. Please refresh." }));
      ws.close(4001, "Unauthorized");
      return;
    }

    const { username, room } = claims;
    const client = clients.get(userId);

    // Leave previous room if switching
    if (client.room && client.room !== room) {
      await removePresence(client.room, userId);
      await broadcastPresence(client.room);
    }

    client.room = room;
    client.username = username;

    await setPresence(room, userId, username);

    // Send history so the user sees past messages immediately
    const history = await getHistory(room);
    ws.send(JSON.stringify({ type: "history", payload: history }));

    // Tell everyone in the room who is online
    await broadcastPresence(room);

    console.log(`[ws] ${username} joined room=${room}`);
  }

  async function handleMessage(userId, packet) {
    const client = clients.get(userId);
    if (!client?.room) return;

    const { content } = packet;
    if (!content?.trim()) return;

    // Persist first — if the publish succeeds but the save fails we'd lose it
    const saved = await saveMessage({
      room: client.room,
      username: client.username,
      content: content.trim(),
    });

    // Publish to Redis so ALL server instances can fan out to their clients
    await pub.publish(CHANNEL, JSON.stringify(saved));
  }

  async function handleHeartbeat(userId) {
    const client = clients.get(userId);
    if (client?.room) {
      await refreshPresence(client.room, userId);
    }
  }

  async function handleDisconnect(userId) {
    const client = clients.get(userId);
    if (client?.room) {
      await removePresence(client.room, userId);
      await broadcastPresence(client.room);
    }
    clients.delete(userId);
    console.log(`[ws] client disconnected  userId=${userId}`);
  }

  // Sends the current online user list to every local client in a room
  async function broadcastPresence(room) {
    const presence = await getPresence(room);
    const usernames = Object.values(presence);
    const packet = JSON.stringify({ type: "presence", payload: usernames });

    for (const [, client] of clients) {
      if (client.room === room && client.ws.readyState === 1) {
        client.ws.send(packet);
      }
    }
  }
}
