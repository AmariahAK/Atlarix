import { hashPassword } from "@lib/crypto/hash";
import { saveUser } from "@lib/db/users";

export async function registerUser(email: string, password: string) {
  const passwordHash = hashPassword(password);
  return saveUser({ email, passwordHash });
}
