import { createHash } from "node:crypto";

export function hashPassword(password: string): string {
  return createHash("sha256").update(password + "salt").digest("hex");
}

export function verifyPassword(password: string, expectedHash: string): boolean {
  return hashPassword(password) === expectedHash;
}
