/**
 * The name and picture belonging to the provider the person actually used.
 *
 * PORTED FROM `atlarix-launchpad/src/components/account/AccountCard.tsx`, whose
 * docblock records a bug found on a real three-identity account and worth not
 * rediscovering here.
 *
 * WHY NOT JUST `user_metadata`. Because it is a MERGED blob, not a record of one
 * identity. Every linked provider writes its claims into the same object and
 * later sign-ins overwrite earlier keys — so on an account with Google and
 * GitHub linked you can get the GitHub photograph under a Google badge, from
 * data that all looks perfectly consistent. `identities` keeps them separate, so
 * the avatar is read from the identity whose `provider` matches the one being
 * shown, with the merged blob as the fallback for accounts that have no
 * `identities` array at all.
 *
 * The two providers spell the key differently — GitHub says `avatar_url`, Google
 * says `picture` — which is the other thing this exists to hide.
 */

import type { StoredUser } from "./session";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

function pickAvatar(bag: Record<string, unknown> | undefined): string | null {
  if (!bag) return null;
  return str(bag.avatar_url) ?? str(bag.picture);
}

function pickName(bag: Record<string, unknown> | undefined): string | null {
  if (!bag) return null;
  return str(bag.full_name) ?? str(bag.name) ?? str(bag.user_name);
}

export interface Profile {
  name: string | null;
  avatar: string | null;
  email: string | null;
  /** `google` | `github` | "" when unknown. */
  provider: string;
  /** Up to two letters, for when there is no picture to show. */
  initials: string;
  /** The best single line to label the account with. */
  label: string;
}

/** Up to two letters, from the name if there is one, else the email. */
export function initialsOf(
  name: string | null,
  email: string | null | undefined,
): string {
  const source = name ?? email ?? "";
  const words = source
    // Drop the domain: an email's initials should come from the local part, or
    // half of them are the provider's.
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0]);
  return letters.join("").toUpperCase() || "?";
}

export function profileOf(user: StoredUser | null | undefined): Profile {
  if (!user) {
    return {
      name: null,
      avatar: null,
      email: null,
      provider: "",
      initials: "?",
      label: "Signed in",
    };
  }
  const provider = String(user.app_metadata?.provider ?? "");
  const own = user.identities?.find(
    (i) => i.provider === provider,
  )?.identity_data;
  const merged = user.user_metadata;

  const name = pickName(own) ?? pickName(merged);
  const email = str(user.email);
  return {
    name,
    avatar: pickAvatar(own) ?? pickAvatar(merged),
    email,
    provider,
    initials: initialsOf(name, email),
    // Name first: it is what the person calls themselves. The email is the
    // fallback, and the id is the last resort — it is a UUID, but a UUID is
    // still more honest than an empty chip.
    label: name ?? email ?? user.id,
  };
}
