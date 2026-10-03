/**
 * The code a person types for `atlarix login --device`: XXXX-XXXX from 20
 * consonants (no vowels, so no words; no I/O/U/Y look-alikes). 20^8 ≈ 2.6e10.
 */
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export function randomUserCode(): string {
  let out = "";
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      // 240 = 12 × 20: rejecting the rest keeps every letter equally likely.
      if (b < 240 && out.length < 8) out += ALPHABET[b % 20];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** What the user typed → the stored form (case, spaces and dashes forgiven). */
export function normalizeUserCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z]/g, "");
  if (s.length !== 8 || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

