# Deploying Ripple to your VPS

This guide deploys the whole app — Node server + Redis + Postgres — with a single
`docker compose up`. You'll reach it at `http://<your-vps-ip>`.

> **Why this works:** the Node server now serves the client files *and* the
> WebSocket on the same port (3001 inside the container, mapped to port 80 on the
> host). Redis and Postgres run as sibling containers and are reached over
> Compose's private network — they are **not** exposed to the internet.

---

## What changed to make it deployable

| Change | File | Why |
|---|---|---|
| WS URL derived from `location.host` | `client/app.js` | The browser must connect back to the VPS, not `localhost`. Also auto-upgrades to `wss://` if you add HTTPS later. |
| `express.static` serves the client | `server/src/index.js` | One container serves the page + the socket — no separate web server needed. |
| `Dockerfile` | new | Builds the Node app into an image. |
| `app` service added | `docker-compose.yml` | Runs the server next to Redis/Postgres; maps host `:80` → container `:3001`. |
| Redis/Postgres bound to `127.0.0.1` | `docker-compose.yml` | Keeps your data stores off the public internet. |

---

## Step 1 — get the code onto the VPS

Pick **one** option.

**Option A — git (if this repo is pushed somewhere):**
```bash
ssh root@<your-vps-ip>
git clone <your-repo-url> ripple
cd ripple
```

**Option B — copy from your laptop** (run this on your *laptop*, not the VPS):
```bash
# from inside the chat-system-design folder
rsync -av --exclude node_modules --exclude .git ./ root@<your-vps-ip>:/root/ripple/
ssh root@<your-vps-ip>
cd /root/ripple
```

---

## Step 2 — open the firewall for HTTP

```bash
ufw allow 80/tcp     # if ufw is active; harmless if it isn't
```
Most VPS providers (Hetzner, DigitalOcean, etc.) also have a firewall in their web
dashboard — make sure port **80** is allowed there too.

---

## Step 3 — build and start everything

```bash
docker compose up -d --build
```

First run takes a minute (it pulls Postgres + Redis and builds the Node image).

Check it came up:
```bash
docker compose ps          # all three services should be "running"/"healthy"
docker compose logs -f app # watch the server boot; Ctrl-C to stop watching
```
You're looking for:
```
[db] schema ready
[server] listening on http://localhost:3001
```

---

## Step 4 — open it

In your browser: **`http://<your-vps-ip>`**

Enter a name and a room. Open a second browser tab (or another device) with the
same room to see live presence and messages flow between them.

Quick health check from the terminal:
```bash
curl http://<your-vps-ip>/health      # → {"status":"ok"}
```

---

## Everyday commands

```bash
docker compose logs -f app     # tail the server logs
docker compose restart app     # restart just the Node server
docker compose down            # stop everything (data is kept in the volume)
docker compose up -d --build   # rebuild + restart after you change code
docker compose down -v         # stop AND wipe the Postgres volume (fresh start)
```

---

## Troubleshooting

**Page won't load / connection refused**
- `docker compose ps` — is `app` running? If it's restarting, check `docker compose logs app`.
- Is port 80 open in *both* `ufw` and your provider's dashboard firewall?
- Is something else (nginx, Apache) already using port 80? `ss -tlnp | grep :80`.
  If so, stop it (`systemctl stop nginx`) or change the mapping in
  `docker-compose.yml` to e.g. `"8080:3001"` and visit `http://<ip>:8080`.

**Page loads but messages don't send ("Cannot reach server")**
- The WebSocket couldn't connect. Confirm you're reaching the site by IP (not
  `localhost`) and that `app` logs show no errors.

**`app` keeps restarting**
- Almost always Postgres/Redis weren't ready. The compose file already waits on
  healthchecks, but check `docker compose logs postgres` for disk/permission errors.

---

## Next step: HTTPS (optional, when you add a domain)

Right now traffic is plain `http://` + `ws://`. When you point a domain at the VPS,
put a reverse proxy (Caddy is the easiest — automatic TLS) in front:

1. Map the app to an internal port instead of 80 (`"3001:3001"` and bind to
   `127.0.0.1`).
2. Run Caddy with a one-line `Caddyfile`:
   ```
   chat.yourdomain.com {
       reverse_proxy 127.0.0.1:3001
   }
   ```
3. The client already auto-switches to `wss://` when served over HTTPS — no code
   change needed.

---

## How this maps to the system design concepts

You're not just deploying — you're seeing the architecture run for real:

- **Stateless app tier.** The `app` container holds no durable state. That's the
  whole point of pushing presence into Redis and history into Postgres — you could
  add `--scale app=3` behind a load balancer and Redis pub/sub keeps them in sync
  (that's Phase 2 in the README).
- **Private data tier.** Redis and Postgres bound to `127.0.0.1` mirrors production
  reality: data stores sit on a private network, never the public internet.
- **One process, two protocols.** HTTP (page + health check) and WebSocket share a
  port because `ws` upgrades an ordinary HTTP connection — a detail worth
  understanding before you scale out.
- **Healthchecks + dependency ordering.** `depends_on: condition: service_healthy`
  is the local-dev version of readiness probes in Kubernetes.
