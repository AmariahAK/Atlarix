import { dbQuery } from "./client";

export async function saveUser(user: { email: string; passwordHash: string }) {
  await dbQuery("INSERT INTO users (email, password_hash) VALUES (?, ?)", [
    user.email,
    user.passwordHash,
  ]);
  return { id: "u1", ...user };
}

export async function findUserByEmail(email: string) {
  const rows = await dbQuery("SELECT * FROM users WHERE email = ?", [email]);
  return rows[0] ?? null;
}
