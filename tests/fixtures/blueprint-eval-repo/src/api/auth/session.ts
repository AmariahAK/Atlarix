import { dbQuery } from "@lib/db/client";

export async function createSession(userId: string) {
  const token = Math.random().toString(36).slice(2);
  await dbQuery("INSERT INTO sessions (user_id, token) VALUES (?, ?)", [
    userId,
    token,
  ]);
  return token;
}

export async function invalidateSession(token: string) {
  await dbQuery("DELETE FROM sessions WHERE token = ?", [token]);
}
