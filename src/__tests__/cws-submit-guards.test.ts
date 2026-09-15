/**
 * The Chrome Web Store API answers 200 OK with a failure in the body. These
 * tests exist to prove the two guards that know that actually fire.
 *
 * WHY THIS FILE IS WORTH ITS WEIGHT. `scripts/cws-submit.mjs` has exactly one
 * interesting property: it does not trust an HTTP status code. If
 * `assertUploadOk` or `assertPublishOk` ever stopped throwing, every run would
 * go green, the log would say "Submitted for review", and the first anyone
 * heard of it would be a user asking why the extension never updated. That is
 * indistinguishable from success from inside CI, which is the definition of a
 * guard that has to be tested by watching it FAIL rather than by watching the
 * happy path pass.
 *
 * This project has shipped two guards that went green against broken input, so
 * every case below asserts the throw, and asserts that the Store's own wording
 * survives into the message — a guard that fires with "upload failed" and drops
 * the `itemError` sends the next person to read CI logs that say nothing.
 */

import { describe, expect, it } from "vitest";

import {
  assertPublishOk,
  assertUploadOk,
  deriveItemId,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error — a plain .mjs build script with no type declarations.
} from "../../scripts/cws-submit.mjs";

describe("assertUploadOk", () => {
  it("accepts the one state that means the bytes landed", () => {
    expect(() => assertUploadOk({ uploadState: "SUCCESS" })).not.toThrow();
  });

  it("THROWS on FAILURE, and quotes the Store's own error", () => {
    // The shape the Store returns when the draft is locked because a version
    // is already in review — which is exactly the state item 1.0.0 is in, and
    // the most likely failure the first real run will hit.
    expect(() =>
      assertUploadOk({
        uploadState: "FAILURE",
        itemError: [
          {
            error_code: "ITEM_NOT_UPDATABLE",
            error_detail:
              "Cannot update the item while it is in the review queue.",
          },
        ],
      }),
    ).toThrow(/Cannot update the item while it is in the review queue/);
  });

  it("THROWS on IN_PROGRESS — accepted is not the same as finished", () => {
    // The subtle one. `IN_PROGRESS` looks benign and is not: publishing against
    // a package the Store has not finished ingesting is a publish of whatever
    // was there before.
    expect(() => assertUploadOk({ uploadState: "IN_PROGRESS" })).toThrow(
      /IN_PROGRESS/,
    );
  });

  it("THROWS when uploadState is absent rather than treating it as fine", () => {
    // A body with no verdict is not a pass. If Google ever renames the field,
    // the failure has to be loud here rather than silently optimistic.
    expect(() => assertUploadOk({})).toThrow(/absent/);
    expect(() => assertUploadOk(null)).toThrow(/absent/);
  });
});

describe("assertPublishOk", () => {
  it("accepts a status array containing OK", () => {
    expect(() => assertPublishOk({ status: ["OK"] })).not.toThrow();
  });

  it("THROWS on NOT_AUTHORIZED, and keeps statusDetail", () => {
    expect(() =>
      assertPublishOk({
        status: ["NOT_AUTHORIZED"],
        statusDetail: ["The caller does not own this item."],
      }),
    ).toThrow(/does not own this item/);
  });

  it("THROWS when status is a bare string rather than an array", () => {
    // `status` is documented as an array. A string "OK" would pass a naive
    // `includes` check by accident — "OK".includes("OK") is true — so the
    // Array.isArray narrowing is load-bearing and this pins it.
    expect(() => assertPublishOk({ status: "OK" })).toThrow();
  });

  it("THROWS on an empty body", () => {
    expect(() => assertPublishOk({})).toThrow(/absent/);
  });
});

describe("deriveItemId", () => {
  it("derives the published id from manifest.key", () => {
    // Not a tautology: it recomputes sha256(DER) → a-p from the real manifest
    // and compares against the id the Store actually assigned. A mistyped key
    // fails here rather than at publish time, against someone else's item.
    expect(deriveItemId()).toBe("fkoacefbjjjhjceidagdajkgclfjacbe");
  });
});
