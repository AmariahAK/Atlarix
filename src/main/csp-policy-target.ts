/**
 * Which responses get the app's Content-Security-Policy stamped on them.
 *
 * Extracted from `installContentSecurityPolicy` so the rule is testable without
 * booting Electron — it decides whether a dedicated worker runs under a policy at
 * all, and it was wrong for several releases with a docstring that said
 * otherwise. (The worker that exposed it was the on-device speech engine's, since
 * deleted; the rule stays for the next one.)
 */

/** Electron WebRequest resource types this predicate cares about. */
export type CspResourceType = string;

/**
 * True when this response should carry the app CSP.
 *
 * `file://` only: web search's hidden pages load arbitrary sites in their own
 * sessions and must not be constrained by the app's policy.
 *
 * `mainFrame`/`subFrame` are the app document. `script`/`other` are how a
 * DEDICATED MODULE WORKER's own script arrives — Electron's WebRequest has no
 * `worker` resourceType — and a worker does not inherit its owner document's
 * policy, so without these it runs unconstrained. Including them is safe rather
 * than broad: a CSP header on an ordinary subresource script response is ignored
 * by the renderer; only documents and worker scripts honour their own.
 */
export function isCspPolicyTarget(
  resourceType: CspResourceType,
  url: string,
): boolean {
  if (!/^file:\/\//i.test(url)) return false;
  return (
    resourceType === "mainFrame" ||
    resourceType === "subFrame" ||
    resourceType === "script" ||
    resourceType === "other"
  );
}
