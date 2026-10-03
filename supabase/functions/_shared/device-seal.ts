/**
 * Sealing a session for ONE device-code sign-in. Plain WebCrypto, so the same
 * file runs in the edge function (Deno) and the CLI (Bun) — the CLI imports it
 * from here, there is no second copy to drift.
 *
 *   CLI    makes an ECDH P-256 key pair, sends the public half with `start`.
 *   server on approve: makes its own one-time pair, derives the shared secret,
 *          HKDF-SHA256 → AES-256-GCM key, encrypts the session JSON, stores
 *          `v1.<server public>.<iv>.<ciphertext>` and forgets its private key.
 *   CLI    on poll: derives the same key from its private half and opens it.
 *
 * The database (and anyone who reads it) only ever sees the sealed form.
 */

const subtle = globalThis.crypto.subtle;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const INFO = new TextEncoder().encode("atlarix cli device sign-in v1");

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface DeviceKeyPair {
  /** Raw uncompressed P-256 point, base64url — what `start` sends. */
  publicKey: string;
  privateKey: CryptoKey;
}

export async function makeDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = (await subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
  return { publicKey: b64url(await subtle.exportKey("raw", pair.publicKey)), privateKey: pair.privateKey };
}

async function aesKey(privateKey: CryptoKey, peerPublic: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const peer = await subtle.importKey("raw", unb64url(peerPublic), ECDH, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A P-256 public key we can use, or false (wrong length, not on the curve). */
export async function isValidPublicKey(publicKey: string): Promise<boolean> {
  try {
    const raw = unb64url(publicKey);
    if (raw.length !== 65 || raw[0] !== 4) return false;
    await subtle.importKey("raw", raw, ECDH, false, []);
    return true;
  } catch {
    return false;
  }
}

export async function sealFor(clientPublicKey: string, plaintext: string): Promise<string> {
  const mine = (await subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
  const minePublic = b64url(await subtle.exportKey("raw", mine.publicKey));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  // Salt: the server's one-time public half; AAD: the client's. The ciphertext
  // is bound to both, so it opens only for the key pair it was sealed to.
  const key = await aesKey(mine.privateKey, clientPublicKey, unb64url(minePublic));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: unb64url(clientPublicKey) }, key, new TextEncoder().encode(plaintext));
  return ["v1", minePublic, b64url(iv), b64url(ct)].join(".");
}

export async function openSealed(pair: DeviceKeyPair, sealed: string): Promise<string> {
  const [v, serverPublic, iv, ct] = sealed.split(".");
  if (v !== "v1" || !serverPublic || !iv || !ct) throw new Error("Unrecognised sealed session.");
  const key = await aesKey(pair.privateKey, serverPublic, unb64url(serverPublic));
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(iv), additionalData: unb64url(pair.publicKey) },
    key,
    unb64url(ct),
  );
  return new TextDecoder().decode(pt);
}
