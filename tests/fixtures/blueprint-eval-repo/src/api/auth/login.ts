import { verifyPassword } from "@lib/crypto/hash";
import { createSession } from "./session";
import { findUserByEmail } from "@lib/db/users";

export async function loginUser(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user) return null;
  const ok = verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  return createSession(user.id);
}
