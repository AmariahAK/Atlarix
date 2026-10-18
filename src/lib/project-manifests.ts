import fs from "node:fs";

/**
 * The build/package manifests at a workspace's root, for the system prompt.
 *
 * Models default to JavaScript habits: asked to "run the tests" in a Rust or
 * Python project they reach for `package.json` first (owner, 2026-10-04: "what
 * makes atlarix always assume every project has a package.json"). Naming what
 * IS there — and saying when nothing is — costs one readdir per turn and stops
 * the guess. Root only: monorepos keep theirs deeper, and discovery covers that.
 */
const NAMES = new Set([
  "package.json", "deno.json", "bun.lockb",
  "Cargo.toml",
  "pyproject.toml", "requirements.txt", "setup.py", "Pipfile",
  "go.mod",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle",
  "Gemfile", "composer.json", "mix.exs", "Package.swift", "pubspec.yaml",
  "CMakeLists.txt", "Makefile", "justfile", "Taskfile.yml", "dune-project", "stack.yaml",
]);
const SUFFIXES = [".csproj", ".sln", ".fsproj", ".cabal", ".nimble"];

export function rootManifests(workspaceRoot: string): string[] {
  try {
    return fs
      .readdirSync(workspaceRoot)
      .filter((n) => NAMES.has(n) || SUFFIXES.some((s) => n.endsWith(s)))
      .sort();
  } catch {
    return [];
  }
}

/** The prompt line, or "" when the root can't be read. */
export function projectManifestsHint(workspaceRoot: string | undefined): string {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return "";
  const found = rootManifests(workspaceRoot);
  if (found.length === 0) {
    return "Project files: no common build manifest at the workspace root. Find out how this project builds and tests before running anything.";
  }
  return `Project files at the workspace root: ${found.map((n) => `\`${n}\``).join(", ")}. Take the project's commands from these.`;
}
