import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import { pub, sub, setPresence, removePresence, getPresence, refreshPresence } from "./redis.js";
import { saveMessage, getHistory } from "./db.js";
import { verifyToken, sanitizeRoom, checkRoomAccess } from "./auth.js";

const CHANNEL = "chat:messages";

// Token-bucket rate limiter — burst of 10, then 1 msg/sec
const MAX_TOKENS = 10;
const REFILL_MS  = 1000;

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

  // userId → { ws, username, rooms: Set<string>, allow }
  // A client can be present in multiple rooms simultaneously so messages
  // received on any room are delivered without needing to switch.
  const clients = new Map();

  sub.subscribe(CHANNEL, (err) => {
    if (err) console.error("[redis] subscribe error", err);
    else console.log(`[redis] subscribed to ${CHANNEL}`);
  });

  sub.on("message", (_channel, raw) => {
    const msg = JSON.parse(raw);
    for (const [, client] of clients) {
      if (client.rooms.has(msg.room) && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify({ type: "message", payload: msg }));
      }
    }
  });

  wss.on("connection", (ws) => {
    const userId = uuidv4();
    const allow  = makeRateLimiter();
    clients.set(userId, { ws, username: null, rooms: new Set(), allow });

    ws.on("message", async (raw) => {
      if (!allow()) {
        ws.send(JSON.stringify({ type: "error", payload: "Rate limit exceeded. Slow down." }));
        return;
      }
      let packet;
      try { packet = JSON.parse(raw); } catch { return; }

      switch (packet.type) {
        case "join":      await handleJoin(userId, packet, ws);      break;
        case "leave":     await handleLeave(userId, packet);         break;
        case "message":   await handleMessage(userId, packet);       break;
        case "heartbeat": await handleHeartbeat(userId);             break;
        default: console.warn("[ws] unknown packet type:", packet.type);
      }
    });

    ws.on("close", () => handleDisconnect(userId));
    ws.on("error", (err) => console.error(`[ws] error userId=${userId}`, err));
  });

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleJoin(userId, packet, ws) {
    let claims;
    try {
      claims = verifyToken(packet.token);
    } catch {
      ws.send(JSON.stringify({ type: "error", payload: "Invalid or expired token. Please refresh." }));
      ws.close(4001, "Unauthorized");
      return;
    }

    const username = claims.username;
    const room     = sanitizeRoom(packet.room ?? "");

    if (!room) {
      ws.send(JSON.stringify({ type: "error", payload: "Room name required." }));
      return;
    }

    // DM access control — only the two named participants can join
    const denied = checkRoomAccess(room, username);
    if (denied) {
      ws.send(JSON.stringify({ type: "error", payload: denied }));
      return;
    }

    const client = clients.get(userId);
    client.username = username;
    client.rooms.add(room);

    await setPresence(room, userId, username);

    const history = await getHistory(room);
    ws.send(JSON.stringify({ type: "history", payload: history, room }));

    await broadcastPresence(room);
    console.log(`[ws] ${username} joined room=${room}`);
  }

  async function handleLeave(userId, packet) {
    const client = clients.get(userId);
    const room   = packet.room;
    if (!room || !client?.rooms.has(room)) return;

    client.rooms.delete(room);
    await removePresence(room, userId);
    await broadcastPresence(room);
    console.log(`[ws] ${client.username} left room=${room}`);
  }

  async function handleMessage(userId, packet) {
    const client = clients.get(userId);
    const room   = packet.room;
    if (!client?.rooms.has(room)) return;

    const { content } = packet;
    if (!content?.trim()) return;

    const saved = await saveMessage({
      room,
      username: client.username,
      content:  content.trim(),
    });

    await pub.publish(CHANNEL, JSON.stringify(saved));
  }

  async function handleHeartbeat(userId) {
    const client = clients.get(userId);
    for (const room of client?.rooms ?? []) {
      await refreshPresence(room, userId);
    }
  }

  async function handleDisconnect(userId) {
    const client = clients.get(userId);
    for (const room of client?.rooms ?? []) {
      await removePresence(room, userId);
      await broadcastPresence(room);
    }
    clients.delete(userId);
    console.log(`[ws] disconnected userId=${userId}`);
  }

  async function broadcastPresence(room) {
    const presence   = await getPresence(room);
    const usernames  = Object.values(presence);
    const packet     = JSON.stringify({ type: "presence", payload: usernames, room });

    for (const [, client] of clients) {
      if (client.rooms.has(room) && client.ws.readyState === 1) {
        client.ws.send(packet);
      }
    }
  }
}
