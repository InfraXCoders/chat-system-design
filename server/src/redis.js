import Redis from "ioredis";

// Two separate clients: one dedicated to SUBSCRIBE (it can't do other commands
// while subscribed), one for all other Redis ops.
export const pub = new Redis(process.env.REDIS_URL);
export const sub = new Redis(process.env.REDIS_URL);

// ── Presence ──────────────────────────────────────────────────────────────────
// We store each online user as a key in a Redis Hash per room.
// Key pattern:  presence:<room>   field: <userId>   value: <username>
// Keys expire so stale entries auto-clean if a server crashes.

const PRESENCE_TTL = 30; // seconds — clients heartbeat every 15 s

export async function setPresence(room, userId, username) {
  await pub.hset(`presence:${room}`, userId, username);
  await pub.expire(`presence:${room}`, PRESENCE_TTL);
}

export async function removePresence(room, userId) {
  await pub.hdel(`presence:${room}`, userId);
}

export async function getPresence(room) {
  const hash = await pub.hgetall(`presence:${room}`);
  // Returns { userId: username, ... } or {} if nobody online
  return hash ?? {};
}

export async function refreshPresence(room, userId) {
  // Reset the TTL so the room key stays alive
  await pub.expire(`presence:${room}`, PRESENCE_TTL);
}
