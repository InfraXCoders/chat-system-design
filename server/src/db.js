import pg from "pg";

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room        TEXT NOT NULL,
      username    TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_created
      ON messages (room, created_at DESC);
  `);
  console.log("[db] schema ready");
}

export async function saveMessage({ room, username, content }) {
  const { rows } = await pool.query(
    `INSERT INTO messages (room, username, content)
     VALUES ($1, $2, $3) RETURNING *`,
    [room, username, content]
  );
  return rows[0];
}

// Returns the last `limit` messages for a room, oldest-first
export async function getHistory(room, limit = 50) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT * FROM messages WHERE room = $1
       ORDER BY created_at DESC LIMIT $2
     ) sub ORDER BY created_at ASC`,
    [room, limit]
  );
  return rows;
}
