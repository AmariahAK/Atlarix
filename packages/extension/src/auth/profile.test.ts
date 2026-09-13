/**
 * Whose face is that?
 *
 * THE THIRD TEST IS THE REASON THIS MODULE EXISTS. `user_metadata` is a MERGED
 * blob — every linked provider writes into the same object and later sign-ins
 * overwrite earlier keys — so an account with two providers can show one's
 * photograph under the other's name, from data that looks entirely consistent.
 * The launchpad found it on a real three-identity account, which is the only way
 * to see it; this is the same defect held still in a unit test.
 */

import { describe, expect, it } from "vitest";
import { initialsOf, profileOf } from "./profile";

describe("one provider", () => {
  it("reads Google's `picture`", () => {
    const p = profileOf({
      id: "u1",
      email: "a@example.test",
      app_metadata: { provider: "google" },
      identities: [
        {
          provider: "google",
          identity_data: {
            picture: "https://lh3.google.test/a.jpg",
            full_name: "Ada Lovelace",
          },
        },
      ],
    });
    expect(p.avatar).toBe("https://lh3.google.test/a.jpg");
    expect(p.label).toBe("Ada Lovelace");
  });

  it("reads GitHub's `avatar_url`, which is a different key for the same thing", () => {
    const p = profileOf({
      id: "u1",
      app_metadata: { provider: "github" },
      identities: [
        {
          provider: "github",
          identity_data: {
            avatar_url: "https://avatars.github.test/u/1",
            user_name: "ada",
          },
        },
      ],
    });
    expect(p.avatar).toBe("https://avatars.github.test/u/1");
    expect(p.label).toBe("ada");
  });
});

describe("two linked providers", () => {
  it("takes the picture from the provider actually signed in with", () => {
    // THE BUG. `user_metadata` says avatar_url (GitHub's key, written last),
    // while `app_metadata.provider` says google. Reading the merged blob shows
    // a GitHub photograph for a Google sign-in and nothing looks wrong.
    const p = profileOf({
      id: "u1",
      email: "a@example.test",
      app_metadata: { provider: "google" },
      user_metadata: {
        avatar_url: "https://avatars.github.test/u/1",
        user_name: "ada-on-github",
      },
      identities: [
        {
          provider: "google",
          identity_data: {
            picture: "https://lh3.google.test/a.jpg",
            full_name: "Ada Lovelace",
          },
        },
        {
          provider: "github",
          identity_data: { avatar_url: "https://avatars.github.test/u/1" },
        },
      ],
    });
    expect(p.avatar).toBe("https://lh3.google.test/a.jpg");
    expect(p.name).toBe("Ada Lovelace");
  });
});

describe("falling back", () => {
  it("uses the merged blob when there is no identities array", () => {
    // Older accounts, and email sign-ins, have no `identities` at all.
    const p = profileOf({
      id: "u1",
      app_metadata: { provider: "google" },
      user_metadata: { picture: "https://x.test/p.jpg", name: "Ada" },
    });
    expect(p.avatar).toBe("https://x.test/p.jpg");
    expect(p.name).toBe("Ada");
  });

  it("labels with the email when there is no name", () => {
    expect(profileOf({ id: "u1", email: "a@example.test" }).label).toBe(
      "a@example.test",
    );
  });

  it("falls back to the id rather than an empty chip", () => {
    // A UUID is not pretty. It is more honest than showing nothing.
    expect(profileOf({ id: "u1" }).label).toBe("u1");
  });

  it("survives a null user without throwing in a render", () => {
    expect(profileOf(null)).toMatchObject({ avatar: null, initials: "?" });
  });
});

describe("initials", () => {
  it("takes the LOCAL part of an email, not the domain", () => {
    // Otherwise half of everyone's initials are their mail provider's.
    expect(initialsOf(null, "amariah.abish@gmail.com")).toBe("AA");
  });

  it("takes two words from a name", () => {
    expect(initialsOf("Ada Lovelace", null)).toBe("AL");
  });

  it("splits on dots, underscores and hyphens as well as spaces", () => {
    expect(initialsOf("ada_lovelace", null)).toBe("AL");
    expect(initialsOf("ada-lovelace", null)).toBe("AL");
  });

  it("gives something rather than nothing when there is neither", () => {
    expect(initialsOf(null, null)).toBe("?");
    expect(initialsOf("", "")).toBe("?");
  });
});
