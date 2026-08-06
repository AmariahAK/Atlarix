/**
 * A pipeline host is free-form, but never silently unpollable.
 *
 * The vendor used to BE the trigger kind (`kind:"github"`), so adding GitLab
 * meant a schema branch, a poller call and a form tab. It is a field now,
 * resolved through a registry — which is also the validation, deliberately: a
 * host nothing can poll would save cleanly and then never fire, and "never
 * fired" is indistinguishable from "nothing happened yet", forever. The user
 * would be waiting on an alert that cannot arrive.
 *
 * That is the shipped-half-feature shape deleted twice already this release (the
 * `ask` ruleset key, `profile.taskCompleteGate`), and worse here because it is
 * silent by construction.
 */
import { describe, it, expect } from "vitest";
import {
  assertPollableHost,
  getPipelineHost,
  pipelineHostIds,
} from "@/lib/automations/pipeline-hosts";
import { AutomationTriggerSchema } from "@/lib/automations/types";

describe("the poller registry", () => {
  it("has GitHub registered — the poller that already existed", () => {
    expect(pipelineHostIds()).toContain("github");
    expect(getPipelineHost("github")?.label).toBe("GitHub");
  });

  it("matches a host case-insensitively and ignores surrounding space", () => {
    // The field is typed by hand, by a user or by a model.
    expect(getPipelineHost("GitHub")).toBeTruthy();
    expect(getPipelineHost("  github ")).toBeTruthy();
  });

  it("refuses an unpollable host, naming what IS supported", () => {
    // Without the list, "unsupported" leaves you guessing at spellings.
    expect(() => assertPollableHost("gitlab")).toThrow(/gitlab/);
    expect(() => assertPollableHost("gitlab")).toThrow(/github/);
    expect(() => assertPollableHost("gitlab")).toThrow(/never fire/i);
  });

  it("returns the host when it can be polled", () => {
    expect(assertPollableHost("github").id).toBe("github");
  });
});

describe("trigger schema", () => {
  const base = {
    repo: "acme/app",
    events: ["ci-failed"],
    intervalMinutes: 15,
  };

  it("accepts a pipeline trigger with any host string", () => {
    // The SCHEMA does not enumerate hosts; the registry decides pollability.
    // Keeping those separate is what lets a new host be one registry entry.
    const parsed = AutomationTriggerSchema.parse({
      kind: "pipeline",
      host: "my-jenkins",
      ...base,
    });
    expect(parsed).toMatchObject({ kind: "pipeline", host: "my-jenkins" });
  });

  it("normalises a legacy github trigger to a pipeline", () => {
    // Migration 0072 rewrites stored rows; this covers anything written by an
    // older build in between, so exactly one shape reaches the runner.
    const parsed = AutomationTriggerSchema.parse({ kind: "github", ...base });
    expect(parsed).toMatchObject({
      kind: "pipeline",
      host: "github",
      repo: "acme/app",
      events: ["ci-failed"],
      intervalMinutes: 15,
    });
  });

  it("still accepts schedule and mcp triggers unchanged", () => {
    expect(
      AutomationTriggerSchema.parse({ kind: "schedule", cron: "0 9 * * 1" }),
    ).toMatchObject({ kind: "schedule" });
    expect(
      AutomationTriggerSchema.parse({
        kind: "mcp",
        serverId: 1,
        tool: "search",
        intervalMinutes: 10,
      }),
    ).toMatchObject({ kind: "mcp" });
  });

  it("still enforces the poll floor", () => {
    expect(() =>
      AutomationTriggerSchema.parse({
        kind: "pipeline",
        host: "github",
        ...base,
        intervalMinutes: 1,
      }),
    ).toThrow();
  });
});
