/**
 * Shared helpers for SWE-bench cross-harness runners. Each runner drives a
 * different agent CLI over the same instances and emits the SAME predictions
 * JSONL ({instance_id, model_patch, model_name_or_path}) that
 * scripts/swebench-grade.mjs grades. Hold the model constant (DeepSeek V4 Pro)
 * across harnesses so only the harness varies.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function loadInstances(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw.startsWith("[")) return JSON.parse(raw);
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Clone (cached) + hard-reset to the instance's base commit. */
export function prepareRepo(inst, workRoot) {
  fs.mkdirSync(workRoot, { recursive: true });
  const dir = path.join(
    workRoot,
    String(inst.instance_id).replace(/[^a-zA-Z0-9_.-]/g, "_"),
  );
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync("git", ["clone", `https://github.com/${inst.repo}.git`, dir], {
      stdio: "ignore",
    });
  }
  git(dir, ["reset", "--hard"]);
  git(dir, ["clean", "-fdx"]);
  git(dir, ["checkout", "--detach", inst.base_commit]);
  return dir;
}

/**
 * Diff vs the base commit, code-only. `extraExcludes` drops each harness's own
 * artifacts (e.g. .atlarix/, .opencode/, CLAUDE.md scratch) so the patch applies
 * cleanly under the grader.
 */
export function capturePatch(dir, baseCommit, extraExcludes = []) {
  const excludes = [".atlarix", ".opencode", ...extraExcludes];
  const pathspec = [
    ".",
    ...excludes.map((e) => `:(exclude)${e}`),
    ...excludes.map((e) => `:(exclude)${e}/**`),
  ];
  git(dir, ["add", "-A", "--", ...pathspec]);
  return git(dir, ["diff", "--cached", baseCommit, "--", ...pathspec]);
}

export function openPredictions(outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, "");
  return {
    append(instance_id, model_patch, model_name_or_path) {
      fs.appendFileSync(
        outPath,
        JSON.stringify({ instance_id, model_patch, model_name_or_path }) + "\n",
      );
    },
  };
}

export function parseArgs() {
  const get = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  return {
    instances: get("instances", process.env.SWEBENCH_INSTANCES),
    out: get("out", process.env.SWEBENCH_OUT ?? "predictions.jsonl"),
    workRoot: get(
      "work-root",
      process.env.SWEBENCH_WORKROOT ??
        path.join(process.cwd(), ".swebench-work"),
    ),
    limit: Number(get("limit", process.env.SWEBENCH_LIMIT ?? "0")),
    timeoutMs: Number(
      get("timeout", process.env.SWEBENCH_TIMEOUT_MS ?? "900000"),
    ),
  };
}
