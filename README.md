# Ripple

A production-grade real-time chat app built from scratch to learn the core concepts behind systems like WhatsApp. Phase 1 of a multi-phase system design study.

![Stack](https://img.shields.io/badge/Node.js-22-green) ![Redis](https://img.shields.io/badge/Redis-7-red) ![Postgres](https://img.shields.io/badge/PostgreSQL-16-blue) ![Docker](https://img.shields.io/badge/Docker-compose-blue)

---

## What it looks like

WhatsApp-faithful dark UI — two-panel layout, tailed message bubbles, live presence indicator, sidebar with chat list and preview, mic/send toggle, date chips, and a dot-grid wallpaper background.

---

## How it works

### 1. WebSockets — persistent connections

When a user opens Ripple, the browser opens a **WebSocket** connection to the Node.js server. Unlike HTTP, this connection stays open for the life of the session — no polling, no repeated handshakes. Every message, presence update, and history packet travels through this single persistent pipe.

```
Browser  ──── WebSocket (ws://) ────  Node.js server
```

The server tracks every connected client in a local `Map`:
```
userId → { ws, room, username }
```

### 2. Redis pub/sub — scaling across multiple servers

A single Node.js process can only fan messages out to clients connected to *it*. If you run two servers (for load balancing), a message sent to server A must also reach clients on server B.

Redis pub/sub solves this. Every server **publishes** outgoing messages to a shared Redis channel (`chat:messages`). Every server also **subscribes** to that same channel. When a message arrives on the channel, each server fans it out to its own local clients in the relevant room.

```
Client A → Server 1 → pub → Redis channel → sub → Server 2 → Client B
                                                 → sub → Server 1 → Client C
```

Two Redis clients are required per server instance:
- **`pub`** — publishes messages and handles all other commands
- **`sub`** — dedicated to `SUBSCRIBE` (Redis won't allow other commands on a subscribed connection)

### 3. Presence detection — who is online

Presence is stored in Redis as a **Hash per room**:

```
Key:   presence:<room>
Field: <userId>
Value: <username>
```

- On **join** → `HSET presence:general <userId> <username>` + `EXPIRE 30s`
- On **disconnect** → `HDEL presence:general <userId>`
- On **heartbeat** (every 15 s from client) → `EXPIRE` is reset, keeping the key alive

The TTL acts as a safety net — if a server crashes without sending a disconnect, stale presence entries automatically expire within 30 seconds.

### 4. Message persistence — PostgreSQL

Messages are saved to Postgres *before* being published to Redis. This ordering matters:

```
1. Client sends message
2. Server saves to Postgres  ← durable
3. Server publishes to Redis ← fan-out
```

If publish succeeds but save fails, the message is lost. If save succeeds but publish fails, the message is safe in the DB and can be re-delivered. Postgres-first is the safer order.

When a user joins a room they receive the last 50 messages immediately, loaded from the DB — so history survives server restarts.

Schema:
```sql
CREATE TABLE messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room       TEXT NOT NULL,
  username   TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 5. Heartbeat pattern

The client pings the server every 15 seconds:
```js
{ type: "heartbeat" }
```
The server responds by refreshing the Redis presence TTL. This keeps online status accurate without polling the DB, and detects silent disconnects (e.g. laptop lid closed) within one TTL window.

---

## Architecture diagram

```
┌─────────────┐     WebSocket      ┌──────────────────┐
│  Browser A  │ ←────────────────→ │                  │
└─────────────┘                    │   Node.js Server │──── PostgreSQL
                                   │   (ws + express) │     (message history)
┌─────────────┐     WebSocket      │                  │
│  Browser B  │ ←────────────────→ │                  │
└─────────────┘                    └────────┬─────────┘
                                            │ pub/sub
                                     ┌──────▼──────┐
                                     │    Redis    │
                                     │  pub/sub +  │
                                     │  presence   │
                                     └─────────────┘
```

In production you'd run multiple Node.js instances behind a load balancer — Redis pub/sub keeps them all in sync automatically.

---

## Project structure

```
chat-system-design/
├── docker-compose.yml        # Redis + Postgres — one command to run
├── client/
│   ├── index.html            # Single-page app, no framework
│   ├── style.css             # WhatsApp-style dark UI
│   └── app.js                # WebSocket client, packet dispatch, rendering
└── server/
    ├── package.json
    └── src/
        ├── index.js          # HTTP server entry point, starts everything
        ├── websocket.js      # WebSocket lifecycle, join/message/heartbeat handlers
        ├── redis.js          # pub/sub clients, presence helpers
        └── db.js             # Postgres pool, schema init, save/query messages
```

---

## Running locally

**Prerequisites:** Docker Desktop, Node.js 18+

```bash
# 1. Start Redis and Postgres
docker compose up -d

# 2. Install dependencies
cd server && npm install

# 3. Copy env (edit if needed)
cp .env.example .env   # or the .env is already provided

# 4. Start the server
npm run dev
```

Open `client/index.html` in your browser (or two tabs to test presence).

**Default env:**
```
PORT=3001
DATABASE_URL=postgresql://chat:chat@localhost:5432/chatdb
REDIS_URL=redis://localhost:6379
```

---

## What each file teaches

| File | Core concept |
|---|---|
| `websocket.js` | WebSocket lifecycle, room routing, pub/sub fan-out |
| `redis.js` | Why two Redis clients are needed, TTL-based presence |
| `db.js` | Persist-before-publish, reverse-sort-then-re-sort history query |
| `app.js` | Heartbeat pattern, packet-type dispatch, optimistic mic/send toggle |
| `docker-compose.yml` | Local infra topology matching production shape |

---

## Phase 2 (next)

- **Kafka** as a message bus — decouple ingestion from delivery, replay events
- **Horizontal scaling** — run 3 server instances behind nginx, verify Redis pub/sub syncs them
- **Auth** — JWT-based identity, rooms require tokens
- **Read receipts** — double-tick turns blue when recipient's client ACKs
