import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET ?? "ripple-dev-secret-change-in-prod";
const TTL    = "8h";

function sanitizeUsername(raw) {
  return String(raw ?? "").trim().replace(/[^\w\s-]/g, "").slice(0, 24);
}

export function sanitizeRoom(raw) {
  return String(raw ?? "").trim().toLowerCase().replace(/[^\w:-]/g, "").slice(0, 64);
}

// POST /auth { username } → { token }
// JWT identifies the user only — room access is checked per join, not baked in.
export function authRouter(app) {
  app.post("/auth", (req, res) => {
    const username = sanitizeUsername(req.body.username);
    if (!username) return res.status(400).json({ error: "username required" });
    const token = jwt.sign({ username }, SECRET, { expiresIn: TTL });
    res.json({ token });
  });
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

// DM rooms are named "dm:<userA>:<userB>" with names sorted alphabetically.
// This guarantees the same room ID regardless of who initiates.
export function dmRoomId(a, b) {
  return `dm:${[a, b].sort().join(":")}`;
}

// Returns null if access is allowed, or an error string if denied.
export function checkRoomAccess(room, username) {
  if (!room.startsWith("dm:")) return null; // open room — anyone can join

  const parts = room.slice(3).split(":");
  if (parts.length !== 2) return "Invalid DM room format.";
  // sanitizeRoom lowercases the room, so compare against lowercase username
  if (!parts.includes(username.toLowerCase())) return "You are not a participant in this DM.";
  return null;
}
