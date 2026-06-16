import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET ?? "ripple-dev-secret-change-in-prod";
const TTL    = "8h";

// Strips any character that isn't a letter, digit, space, hyphen, or underscore
function sanitizeUsername(raw) {
  return String(raw ?? "").trim().replace(/[^\w\s-]/g, "").slice(0, 24);
}

function sanitizeRoom(raw) {
  return String(raw ?? "").trim().toLowerCase().replace(/[^\w-]/g, "").slice(0, 32);
}

// POST /auth  { username, room }  →  { token }
export function authRouter(app) {
  app.post("/auth", (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const room     = sanitizeRoom(req.body.room);

    if (!username) return res.status(400).json({ error: "username required" });
    if (!room)     return res.status(400).json({ error: "room required" });

    const token = jwt.sign({ username, room }, SECRET, { expiresIn: TTL });
    res.json({ token });
  });
}

// Verifies a JWT string. Returns the payload or throws.
export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}
