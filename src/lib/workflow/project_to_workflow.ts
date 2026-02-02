/**
 * Project → Workflow - Infer n8n-style workflow from existing codebase
 * Supports all languages Atlarix handles. Prefers detailed inference (Tree-sitter–
 * style: functions, classes, calls, modules) so the canvas shows a real n8n-like
 * workflow you can see and modify; falls back to ecosystem app nodes when needed.
 */

import * as fs from "fs/promises";
import * as path from "path";

/** package name → n8n node type (Node.js) */
const DEP_TO_NODE: Record<string, string> = {
  express: "n8n-nodes-base.webhook",
  stripe: "n8n-nodes-base.stripe",
  "@prisma/client": "n8n-nodes-base.postgres",
  prisma: "n8n-nodes-base.postgres",
  pg: "n8n-nodes-base.postgres",
  mysql2: "n8n-nodes-base.mySql",
  mongodb: "n8n-nodes-base.mongoDb",
  mongoose: "n8n-nodes-base.mongoDb",
  redis: "n8n-nodes-base.redis",
  ioredis: "n8n-nodes-base.redis",
  "@sendgrid/mail": "n8n-nodes-base.sendGrid",
  twilio: "n8n-nodes-base.twilio",
  openai: "n8n-nodes-base.openAi",
  "@slack/web-api": "n8n-nodes-base.slack",
  airtable: "n8n-nodes-base.airtable",
  "@supabase/supabase-js": "n8n-nodes-base.supabase",
  "@notionhq/client": "n8n-nodes-base.notion",
  "discord.js": "n8n-nodes-base.discord",
};

/** Generic app node types for inferred workflows (all languages) */
const ATLAFLOW_APP_NODES: Record<string, string> = {
  react: "atlaflow.reactApp",
  next: "atlaflow.nextApp",
  vue: "atlaflow.vueApp",
  express: "atlaflow.apiServer",
  nodejs: "atlaflow.app",
  python: "atlaflow.pythonApp",
  fastapi: "atlaflow.pythonApi",
  django: "atlaflow.djangoApp",
  flask: "atlaflow.flaskApp",
  go: "atlaflow.goApp",
  rust: "atlaflow.rustApp",
  ruby: "atlaflow.rubyApp",
  java: "atlaflow.javaApp",
  php: "atlaflow.phpApp",
  dotnet: "atlaflow.dotnetApp",
  deno: "atlaflow.denoApp",
  bun: "atlaflow.app",
  elixir: "atlaflow.elixirApp",
};

export interface InferredWorkflow {
  nodes: Array<{
    id: string;
    type: string;
    parameters?: Record<string, unknown>;
    position: [number, number];
  }>;
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

interface ProjectEcosystem {
  ecosystem: string;
  framework?: string;
  deps?: Record<string, string>;
  hasPackageJson?: boolean;
}

async function detectProjectEcosystem(appPath: string): Promise<ProjectEcosystem | null> {
  let rootFiles: string[] = [];
  try {
    rootFiles = await fs.readdir(appPath);
  } catch {
    return null;
  }

  // Node.js (package.json)
  const pkgPath = path.join(appPath, "package.json");
  try {
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(pkgRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    let framework: string | undefined;
    if (deps.next) framework = "next";
    else if (deps.react || deps["react-dom"]) framework = "react";
    else if (deps.vue) framework = "vue";
    else if (deps.express) framework = "express";
    return { ecosystem: "nodejs", framework, deps, hasPackageJson: true };
  } catch {
    // not Node or no package.json
  }

  // Python
  try {
    const pyprojectPath = path.join(appPath, "pyproject.toml");
    const content = await fs.readFile(pyprojectPath, "utf8");
    let framework: string | undefined;
    if (content.includes("fastapi")) framework = "fastapi";
    else if (content.includes("django")) framework = "django";
    else if (content.includes("flask")) framework = "flask";
    return { ecosystem: "python", framework };
  } catch {
    //
  }
  try {
    const reqPath = path.join(appPath, "requirements.txt");
    const content = await fs.readFile(reqPath, "utf8");
    let framework: string | undefined;
    if (content.includes("fastapi")) framework = "fastapi";
    else if (content.includes("django")) framework = "django";
    else if (content.includes("flask")) framework = "flask";
    return { ecosystem: "python", framework };
  } catch {
    //
  }

  // Go
  try {
    await fs.access(path.join(appPath, "go.mod"));
    return { ecosystem: "go" };
  } catch {
    //
  }

  // Rust
  try {
    await fs.access(path.join(appPath, "Cargo.toml"));
    return { ecosystem: "rust" };
  } catch {
    //
  }

  // Ruby
  if (rootFiles.includes("Gemfile")) return { ecosystem: "ruby" };

  // Java
  if (
    rootFiles.some(
      (f) =>
        f === "pom.xml" ||
        f === "build.gradle" ||
        f === "build.gradle.kts" ||
        f === "mvnw" ||
        f === "gradlew"
    )
  ) {
    return { ecosystem: "java" };
  }
  try {
    await fs.access(path.join(appPath, "src", "main", "java"));
    return { ecosystem: "java" };
  } catch {
    //
  }

  // PHP
  if (rootFiles.includes("composer.json")) return { ecosystem: "php" };

  // .NET
  if (rootFiles.some((f) => f.endsWith(".csproj") || f.endsWith(".fsproj") || f.endsWith(".sln")))
    return { ecosystem: "dotnet" };

  // Deno
  if (rootFiles.some((f) => f === "deno.json" || f === "deno.jsonc")) return { ecosystem: "deno" };

  // Bun (bun.lockb without package.json already tried)
  if (rootFiles.includes("bun.lockb") || rootFiles.includes("bunfig.toml"))
    return { ecosystem: "bun" };

  // Elixir
  if (rootFiles.includes("mix.exs")) return { ecosystem: "elixir" };

  return null;
}

function buildLinearConnections(nodes: InferredWorkflow["nodes"]): InferredWorkflow["connections"] {
  const connections: InferredWorkflow["connections"] = {};
  for (let i = 0; i < nodes.length - 1; i++) {
    const src = nodes[i].id;
    const tgt = nodes[i + 1].id;
    connections[src] = { main: [[{ node: tgt }]] };
  }
  return connections;
}

/** Node type for Tree-sitter–style module/file nodes (functions, classes, exports) */
const ATLAFLOW_MODULE = "atlaflow.module";

/**
 * Infer a detailed n8n-like workflow from workspace analysis: modules/files as nodes,
 * with functions, classes, and exports inside; connections from import/call graph.
 * Returns null if analysis fails or yields no nodes.
 */
async function inferDetailedWorkflowFromProject(
  appPath: string
): Promise<InferredWorkflow | null> {
  try {
    const { analyzeWorkspace } = await import("../analysis");
    const analysis = await analyzeWorkspace(appPath);
    const { files, dependencies, clusters, entryPoints, metadata } = analysis;
    const fileMap = new Map<string, (typeof files)[0]>();
    for (const f of files) fileMap.set(f.relativePath, f);

    const nodes: InferredWorkflow["nodes"] = [];
    const nodeIds = new Set<string>();
    const fileToNodeId = new Map<string, string>();
    const stepX = 280;
    const stepY = 140;
    let row = 0;
    let col = 0;

    if (clusters.length >= 1) {
      for (const cluster of clusters) {
        const allFunctions: string[] = [];
        const allClasses: string[] = [];
        const fileList: string[] = cluster.files.slice(0, 10);
        for (const rel of cluster.files) {
          const f = fileMap.get(rel);
          if (f) {
            allFunctions.push(...f.functions.slice(0, 15));
            allClasses.push(...f.classes.slice(0, 10));
          }
        }
        const id = cluster.id;
        nodeIds.add(id);
        for (const rel of cluster.files) fileToNodeId.set(rel, id);
        nodes.push({
          id,
          type: ATLAFLOW_MODULE,
          parameters: {
            label: cluster.purpose || cluster.name,
            files: fileList,
            functions: [...new Set(allFunctions)].slice(0, 30),
            classes: [...new Set(allClasses)].slice(0, 20),
          },
          position: [100 + col * stepX, 80 + row * stepY],
        });
        col++;
        if (col >= 4) {
          col = 0;
          row++;
        }
      }
      // Orphan files (not in any cluster) → single "Other" node
      const inCluster = new Set<string>();
      for (const c of clusters) for (const f of c.files) inCluster.add(f);
      const orphans = files.filter((f) => !inCluster.has(f.relativePath)).map((f) => f.relativePath);
      if (orphans.length > 0) {
        const id = "node-other";
        nodeIds.add(id);
        for (const rel of orphans) fileToNodeId.set(rel, id);
        const first = fileMap.get(orphans[0]);
        nodes.push({
          id,
          type: ATLAFLOW_MODULE,
          parameters: {
            label: "Other",
            files: orphans.slice(0, 8),
            functions: first ? first.functions.slice(0, 20) : [],
            classes: first ? first.classes.slice(0, 15) : [],
          },
          position: [100 + col * stepX, 80 + row * stepY],
        });
      }
    } else {
      const keyFiles = [...new Set([...entryPoints, ...(metadata.hubFiles ?? [])])].slice(0, 20);
      for (const rel of keyFiles) {
        const f = fileMap.get(rel);
        if (!f) continue;
        const id = `file-${nodes.length + 1}`;
        nodeIds.add(id);
        fileToNodeId.set(rel, id);
        const base = path.basename(rel, path.extname(rel));
        nodes.push({
          id,
          type: ATLAFLOW_MODULE,
          parameters: {
            label: base,
            filePath: rel,
            functions: f.functions.slice(0, 25),
            classes: f.classes.slice(0, 15),
            exports: f.exports.slice(0, 15),
          },
          position: [100 + col * stepX, 80 + row * stepY],
        });
        col++;
        if (col >= 4) {
          col = 0;
          row++;
        }
      }
    }

    if (nodes.length === 0) return null;

    const connections: InferredWorkflow["connections"] = {};
    for (const dep of dependencies) {
      const fromId = fileToNodeId.get(dep.from);
      const toId = fileToNodeId.get(dep.to);
      if (!fromId || !toId || fromId === toId) continue;
      if (!connections[fromId]) connections[fromId] = { main: [[]] };
      const targets = connections[fromId].main[0];
      if (!targets.some((t) => t.node === toId)) {
        targets.push({ node: toId });
      }
    }

    return { nodes, connections };
  } catch {
    return null;
  }
}

/**
 * Infer workflow from project — detailed (n8n-like) first, then ecosystem fallback.
 * Supports all Atlarix languages; shows functions, classes, and structure when possible.
 */
export async function inferWorkflowFromProject(
  appPath: string
): Promise<InferredWorkflow | null> {
  const detailed = await inferDetailedWorkflowFromProject(appPath);
  if (detailed && detailed.nodes.length > 0) return detailed;

  const ecosystem = await detectProjectEcosystem(appPath);
  if (!ecosystem) return null;

  const nodes: InferredWorkflow["nodes"] = [];
  let x = 100;
  const y = 200;
  const step = 250;

  // Node.js: use dependency-based nodes first, then generic app node as fallback
  if (ecosystem.ecosystem === "nodejs" && ecosystem.hasPackageJson && ecosystem.deps) {
    const deps = ecosystem.deps;
    const seenTypes = new Set<string>();
    let hasWebhook = false;

    for (const [dep] of Object.entries(deps)) {
      const nodeType = DEP_TO_NODE[dep.toLowerCase()];
      if (nodeType && !seenTypes.has(nodeType)) {
        seenTypes.add(nodeType);
        nodes.push({
          id: `node-${nodes.length + 1}`,
          type: nodeType,
          parameters: {},
          position: [x, y],
        });
        x += step;
        if (nodeType === "n8n-nodes-base.webhook") hasWebhook = true;
      }
    }

    if (!hasWebhook && deps["express"]) {
      nodes.unshift({
        id: "node-webhook",
        type: "n8n-nodes-base.webhook",
        parameters: { path: "/api", method: "POST" },
        position: [100, y],
      });
      for (let i = 1; i < nodes.length; i++) {
        nodes[i].position[0] = 100 + (i + 1) * step;
      }
    }

    if (nodes.length === 0) {
      const genericType =
        ATLAFLOW_APP_NODES[ecosystem.framework ?? "nodejs"] ?? ATLAFLOW_APP_NODES.nodejs;
      nodes.push({
        id: "node-1",
        type: genericType,
        parameters: {},
        position: [x, y],
      });
    }
  } else {
    // Non-Node or Node without package.json: add one generic app node per ecosystem
    const framework = ecosystem.framework ?? ecosystem.ecosystem;
    const genericType =
      ATLAFLOW_APP_NODES[framework] ?? ATLAFLOW_APP_NODES[ecosystem.ecosystem] ?? "atlaflow.app";
    nodes.push({
      id: "node-1",
      type: genericType,
      parameters: {},
      position: [x, y],
    });
  }

  if (nodes.length === 0) return null;

  return {
    nodes,
    connections: buildLinearConnections(nodes),
  };
}
