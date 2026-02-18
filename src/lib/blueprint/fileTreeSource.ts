/**
 * File-tree based blueprint source (no RTE required).
 * Walks project directory, builds rooms/beacons, infers edges from import statements.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type {
  BlueprintRoom,
  BlueprintEdge,
  BlueprintFunction,
  BlueprintFunctionKind,
  BlueprintRoomFlowEdge,
} from "@/shared/blueprint-types";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "out",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".nyc_output",
  "vendor",
]);

const SKIP_FILE_PATTERNS = [
  /\.(test|spec)\.(ts|tsx|js|jsx)$/i,
  /^tsconfig.*\.json$/i,
  /^\.eslintrc.*/i,
  /^\.prettierrc.*/i,
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^requirements\.txt$/i,
  /^pyproject\.toml$/i,
  /^setup\.py$/i,
  /\.config\.(js|ts|mjs)$/i,
  /^Makefile$/i,
  /^Dockerfile$/i,
  /^\.env.*/i,
];

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cs", ".rb", ".php", ".swift", ".kt", ".ex", ".exs",
]);

function shouldSkipFile(name: string): boolean {
  return SKIP_FILE_PATTERNS.some((re) => re.test(name));
}

function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "root";
}

function titleCase(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function inferBeaconKind(filePath: string, baseName: string): BlueprintFunctionKind {
  const lower = (filePath + "/" + baseName).toLowerCase();
  if (/\b(route|handler|controller|endpoint)\b/.test(lower)) return "api";
  if (/\b(webhook|hook)\b/.test(lower)) return "webhook";
  if (/\b(model|schema|type|interface)\b/.test(lower)) return "feature";
  if (/\b(util|helper|lib|service)\b/.test(lower)) return "function";
  return "function";
}

interface WalkEntry {
  relativePath: string;
  absolutePath: string;
  isDir: boolean;
}

async function walkDir(
  dir: string,
  baseDir: string,
  relativePrefix: string,
  entries: WalkEntry[]
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const rel = relativePrefix ? `${relativePrefix}/${name}` : name;
    const abs = path.join(dir, name);
    let stat: { isDirectory(): boolean };
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      await walkDir(abs, baseDir, rel, entries);
    } else {
      const ext = path.extname(name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (shouldSkipFile(name)) continue;
      entries.push({ relativePath: rel, absolutePath: abs, isDir: false });
    }
  }
}

/** Decide container root: project root or src/app/lib/packages if they dominate (>80% of files). */
function chooseContainerRoot(
  projectPath: string,
  allFiles: WalkEntry[]
): { rootDir: string; rootRelative: string } {
  const rootDir = path.normalize(projectPath).replace(/\\/g, "/");
  const candidates = ["src", "app", "lib", "packages"];
  for (const seg of candidates) {
    const candidateDir = path.join(rootDir, seg);
    const prefix = seg + "/";
    const under = allFiles.filter((f) => f.relativePath === seg || f.relativePath.startsWith(prefix));
    if (under.length > 0 && under.length / allFiles.length >= 0.8) {
      return { rootDir: candidateDir, rootRelative: seg };
    }
  }
  return { rootDir, rootRelative: "" };
}

/** Build rooms and beacons from walked files. Adds __deps__ room (hidden). */
function buildRoomsAndBeacons(
  projectPath: string,
  allFiles: WalkEntry[]
): BlueprintRoom[] {
  const normProject = path.normalize(projectPath).replace(/\\/g, "/");
  const { rootDir, rootRelative } = chooseContainerRoot(normProject, allFiles);
  const rootNorm = path.normalize(rootDir).replace(/\\/g, "/");

  const roomIdToRoom = new Map<string, BlueprintRoom>();
  const roomIdsOrder: string[] = [];

  const getRoomId = (segment: string) => {
    const id = slugify(segment);
    if (!roomIdToRoom.has(id)) {
      const absPath = rootRelative ? path.join(rootNorm, segment) : path.join(rootNorm, segment);
      roomIdToRoom.set(id, {
        id,
        label: titleCase(segment),
        path: absPath,
        functions: [],
      });
      roomIdsOrder.push(id);
    }
    return id;
  };

  for (const f of allFiles) {
    const rel = f.relativePath.replace(/\\/g, "/");
    const parts = rel.split("/").filter(Boolean);
    let segment: string;
    if (rootRelative) {
      if (parts[0] !== rootRelative) continue;
      segment = parts.length > 1 ? parts[1] : parts[0];
    } else {
      segment = parts[0];
    }
    if (!segment) continue;
    const roomId = getRoomId(segment);
    const room = roomIdToRoom.get(roomId)!;
    const baseName = path.basename(f.relativePath, path.extname(f.relativePath));
    const beaconId = `${roomId}::${baseName}`;
    const kind = inferBeaconKind(f.relativePath, baseName);
    const fn: BlueprintFunction = {
      id: beaconId,
      name: baseName,
      kind,
      description: f.relativePath,
      file: f.absolutePath,
    };
    room.functions.push(fn);
  }

  const rooms = roomIdsOrder.map((id) => roomIdToRoom.get(id)!);

  const depsRoom: BlueprintRoom = {
    id: "__deps__",
    label: "Dependencies & Config",
    path: normProject,
    functions: [],
    hidden: true,
  };
  return [depsRoom, ...rooms];
}

const IMPORT_JS_TS = /from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_PY_FROM = /from\s+([\w.]+)\s+import/g;
const IMPORT_PY_IMPORT = /^import\s+(\w+)/gm;

function extractImportPaths(content: string, ext: string): string[] {
  const out: string[] = [];
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext.toLowerCase())) {
    let m: RegExpExecArray | null;
    IMPORT_JS_TS.lastIndex = 0;
    while ((m = IMPORT_JS_TS.exec(content)) !== null) {
      const raw = m[1] ?? m[2];
      if (raw) out.push(raw);
    }
  } else if (ext.toLowerCase() === ".py") {
    let m: RegExpExecArray | null;
    IMPORT_PY_FROM.lastIndex = 0;
    while ((m = IMPORT_PY_FROM.exec(content)) !== null) {
      if (m[1]) out.push(m[1]);
    }
    IMPORT_PY_IMPORT.lastIndex = 0;
    while ((m = IMPORT_PY_IMPORT.exec(content)) !== null) {
      if (m[1]) out.push(m[1]);
    }
  }
  return out;
}

async function resolveImportToPath(
  importPath: string,
  fromFileAbsolute: string,
  ext: string
): Promise<string | null> {
  const fromDir = path.dirname(fromFileAbsolute);
  if (ext === ".py") {
    if (importPath.startsWith(".")) {
      const rel = importPath.replace(/\./g, "/").replace(/\/$/, "");
      if (!rel || rel === ".") return null;
      const resolved = path.join(fromDir, rel + ".py");
      try {
        await fs.access(resolved);
        return path.normalize(resolved).replace(/\\/g, "/");
      } catch {
        const initPath = path.join(fromDir, rel, "__init__.py");
        try {
          await fs.access(initPath);
          return path.normalize(initPath).replace(/\\/g, "/");
        } catch {
          return null;
        }
      }
    }
    const asPath = importPath.replace(/\./g, "/");
    const resolved = path.join(fromDir, asPath + ".py");
    try {
      await fs.access(resolved);
      return path.normalize(resolved).replace(/\\/g, "/");
    } catch {
      const initPath = path.join(fromDir, asPath, "__init__.py");
      try {
        await fs.access(initPath);
        return path.normalize(initPath).replace(/\\/g, "/");
      } catch {
        return null;
      }
    }
  }
  if (importPath.startsWith(".")) {
    const base = path.join(fromDir, importPath);
    const candidates = [base + ".ts", base + ".tsx", base + ".js", base + ".jsx", base + "/index.ts", base + "/index.tsx"];
    for (const p of candidates) {
      try {
        await fs.access(p);
        return path.normalize(p).replace(/\\/g, "/");
      } catch {
        // continue
      }
    }
    return null;
  }
  return null;
}

/** Find which room contains the file at absolute path; return room id or null. */
function findRoomByFilePath(rooms: BlueprintRoom[], absolutePath: string): string | null {
  const norm = path.normalize(absolutePath).replace(/\\/g, "/");
  for (const room of rooms) {
    if (room.hidden) continue;
    for (const fn of room.functions) {
      if (fn.file && path.normalize(fn.file).replace(/\\/g, "/") === norm) return room.id;
    }
  }
  return null;
}

/** Find beacon id for a file path. */
function findBeaconIdByFile(rooms: BlueprintRoom[], absolutePath: string): string | null {
  const norm = path.normalize(absolutePath).replace(/\\/g, "/");
  for (const room of rooms) {
    for (const fn of room.functions) {
      if (fn.file && path.normalize(fn.file).replace(/\\/g, "/") === norm) return fn.id;
    }
  }
  return null;
}

async function inferEdgesFromImports(
  rooms: BlueprintRoom[],
  _projectPath: string
): Promise<{ crossRoomEdges: BlueprintEdge[]; flowEdgesByRoomId: Map<string, BlueprintRoomFlowEdge[]> }> {
  const crossRoomEdges: BlueprintEdge[] = [];
  const flowEdgesByRoomId = new Map<string, BlueprintRoomFlowEdge[]>();

  let edgeIndex = 0;
  for (const room of rooms) {
    if (room.hidden) continue;
    for (const fn of room.functions) {
      if (!fn.file) continue;
      let content: string;
      try {
        content = await fs.readFile(fn.file, "utf-8");
      } catch {
        continue;
      }
      const ext = path.extname(fn.file).toLowerCase();
      const importPaths = extractImportPaths(content, ext);
      for (const raw of importPaths) {
        const resolved = await resolveImportToPath(raw, fn.file, ext);
        if (!resolved) continue;
        const toRoomId = findRoomByFilePath(rooms, resolved);
        if (!toRoomId) continue;
        const toBeaconId = findBeaconIdByFile(rooms, resolved);
        if (!toBeaconId) continue;
        if (toRoomId !== room.id) {
          const edgeId = `inferred::${room.id}->${toRoomId}::${edgeIndex++}`;
          crossRoomEdges.push({
            id: edgeId,
            from: room.id,
            to: toRoomId,
            type: "import",
            inferred: true,
          });
        } else {
          const flowId = `inferred-flow::${fn.id}->${toBeaconId}::${edgeIndex++}`;
          const list = flowEdgesByRoomId.get(room.id) ?? [];
          list.push({
            id: flowId,
            from: fn.id,
            to: toBeaconId,
            type: "import",
            inferred: true,
          });
          flowEdgesByRoomId.set(room.id, list);
        }
      }
    }
  }
  return { crossRoomEdges, flowEdgesByRoomId };
}

export async function buildBlueprintFromFileTree(projectPath: string): Promise<{
  rooms: BlueprintRoom[];
  edges: BlueprintEdge[];
  inferredEdges: BlueprintEdge[];
}> {
  const normPath = path.normalize(projectPath);
  const allEntries: WalkEntry[] = [];
  await walkDir(normPath, normPath, "", allEntries);
  const allFiles = allEntries.filter((e) => !e.isDir);

  const rooms = buildRoomsAndBeacons(normPath, allFiles);
  const { crossRoomEdges, flowEdgesByRoomId } = await inferEdgesFromImports(rooms, normPath);

  const roomsWithFlowEdges = rooms.map((r) => {
    const inferredFlow = flowEdgesByRoomId.get(r.id) ?? [];
    const existing = r.flowEdges ?? [];
    return { ...r, flowEdges: [...existing, ...inferredFlow] };
  });

  return {
    rooms: roomsWithFlowEdges,
    edges: [],
    inferredEdges: crossRoomEdges,
  };
}
