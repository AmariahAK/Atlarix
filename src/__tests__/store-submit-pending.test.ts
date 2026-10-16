/**
 * `scripts/store-submit.mjs` used to delete whatever submission was pending
 * before creating a new one. Certification takes up to three business days and
 * releases come faster, so every release cancelled the one before it while
 * Microsoft was still certifying it: the Store sat on 14.51.0 from 2026-09-23
 * through 15.7.1 while every CI run said "Committed".
 *
 * The guard: a pending submission Microsoft is still working on is left alone
 * (this release skips the Store); only one that never got committed or that
 * failed is replaced.
 */

import { describe, expect, it } from "vitest";

import {
  pendingSubmissionAction,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error — a plain .mjs build script with no type declarations.
} from "../../scripts/store-submit.mjs";

describe("pendingSubmissionAction", () => {
  it.each([
    "CommitStarted",
    "PreProcessing",
    "Certification",
    "Release",
    "PendingPublication",
    "Publishing",
  ])("KEEPS a submission still in progress (%s)", (status) => {
    expect(pendingSubmissionAction(status)).toBe("keep");
  });

  it.each([
    "PendingCommit",
    "CommitFailed",
    "PreProcessingFailed",
    "CertificationFailed",
    "ReleaseFailed",
    "PublishFailed",
    "Canceled",
  ])("replaces one that never started or failed (%s)", (status) => {
    expect(pendingSubmissionAction(status)).toBe("replace");
  });

  it("keeps a status it doesn't know: skipping one release is cheaper than cancelling a certification", () => {
    expect(pendingSubmissionAction("SomethingNew")).toBe("keep");
    expect(pendingSubmissionAction(undefined)).toBe("keep");
  });
});
