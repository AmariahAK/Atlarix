import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";

import {
  Problem,
  ProblemReport,
  SyncVirtualFileSystem,
  WorkerInput,
  WorkerOutput,
} from "../../shared/tsc_types";
import { SyncVirtualFileSystemImpl } from "../../shared/VirtualFilesystem";

const nodeRequire = createRequire(import.meta.url);

/**
 * Walk up from this worker bundle to app-root `node_modules/typescript` (packaged Electron / app.asar).
 * Keeps `typescript` external in Vite without relying on devDependency installs in production.
 */
function resolveShippedTypeScriptModule(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 16; i++) {
      const candidate = path.join(dir, "node_modules", "typescript");
      if (
        fs.existsSync(path.join(candidate, "package.json")) &&
        fs.existsSync(path.join(candidate, "lib", "typescript.js"))
      ) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Prefer project-local compiler; fall back to Atlarix's shipped dependency (not bundled — avoids dev OOM). */
function loadTypeScript(appPath: string): typeof import("typescript") {
  try {
    const resolved = nodeRequire.resolve("typescript", { paths: [appPath] });
    return nodeRequire(resolved) as typeof import("typescript");
  } catch {
    try {
      return nodeRequire("typescript") as typeof import("typescript");
    } catch {
      const shipped = resolveShippedTypeScriptModule();
      if (shipped) {
        return nodeRequire(shipped) as typeof import("typescript");
      }
      throw new Error(
        "Cannot load the TypeScript compiler ('typescript' package). Reinstall Atlarix or ensure typescript is available under node_modules.",
      );
    }
  }
}

const TS_CONFIG_CANDIDATES = [
  // For vite applications, we want to check tsconfig.app.json, since it's the
  // most important one (client-side app).
  "tsconfig.app.json",
  // For Next.js applications, it typically has a single tsconfig.json file
  "tsconfig.json",
] as const;

/** Resolves a tsconfig path, or `null` if the workspace is not a TypeScript project. */
function resolveTsConfigPath(appPath: string): string | null {
  for (const config of TS_CONFIG_CANDIDATES) {
    const configPath = path.join(appPath, config);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

async function runTypeScriptCheck(
  ts: typeof import("typescript"),
  vfs: SyncVirtualFileSystem,
  {
    appPath,
    tsconfigPath,
    tsBuildInfoCacheDir,
  }: {
    appPath: string;
    tsconfigPath: string;
    tsBuildInfoCacheDir: string;
  },
): Promise<ProblemReport> {
  return runSingleProject(ts, vfs, {
    appPath,
    tsconfigPath,
    tsBuildInfoCacheDir,
  });
}

async function runSingleProject(
  ts: typeof import("typescript"),
  vfs: SyncVirtualFileSystem,
  {
    appPath,
    tsconfigPath,
    tsBuildInfoCacheDir,
  }: {
    appPath: string;
    tsconfigPath: string;
    tsBuildInfoCacheDir: string;
  },
): Promise<ProblemReport> {
  // Use the idiomatic way to parse TypeScript config
  const parsedCommandLine = ts.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    undefined, // No additional options
    {
      // Custom system object that can handle our virtual files
      ...ts.sys,
      fileExists: (fileName: string) => vfs.fileExists(fileName),
      readFile: (fileName: string) => vfs.readFile(fileName),
      onUnRecoverableConfigFileDiagnostic: (
        diagnostic: import("typescript").Diagnostic,
      ) => {
        throw new Error(
          `TypeScript config error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
        );
      },
    },
  );

  if (!parsedCommandLine) {
    throw new Error(`Failed to parse TypeScript config: ${tsconfigPath}`);
  }

  // Enable incremental compilation by setting tsBuildInfoFile if not already set
  const options = { ...parsedCommandLine.options };
  if (!options.tsBuildInfoFile && options.incremental !== false) {
    // Place the buildinfo file in a temp directory to avoid polluting the project
    const tmpDir = tsBuildInfoCacheDir;
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Create a unique filename based on both the app path and tsconfig path to prevent collisions
    const configName = path.basename(tsconfigPath, path.extname(tsconfigPath));
    const appHash = Buffer.from(appPath)
      .toString("base64")
      .replace(/[/+=]/g, "_");
    options.tsBuildInfoFile = path.join(
      tmpDir,
      `${appHash}-${configName}.tsbuildinfo`,
    );
    options.incremental = true;
  }

  let rootNames = parsedCommandLine.fileNames;

  // Add any virtual files that aren't already included
  const virtualTsFiles = vfs
    .getVirtualFiles()
    .map((file) => path.resolve(appPath, file.path))
    .filter(isTypeScriptFile);

  // Remove deleted files from rootNames
  const deletedFiles = vfs
    .getDeletedFiles()
    .map((file) => path.resolve(appPath, file));
  rootNames = rootNames.filter((fileName) => {
    const resolvedPath = path.resolve(fileName);
    return !deletedFiles.includes(resolvedPath);
  });

  for (const virtualFile of virtualTsFiles) {
    if (!rootNames.includes(virtualFile)) {
      rootNames.push(virtualFile);
    }
  }

  // Create custom compiler host
  const host = createVirtualCompilerHost(ts, appPath, vfs, options);

  // Create incremental program - TypeScript will automatically use the tsBuildInfo file
  const builderProgram = ts.createIncrementalProgram({
    rootNames,
    options,
    host,
    configFileParsingDiagnostics:
      ts.getConfigFileParsingDiagnostics(parsedCommandLine),
  });

  // Get diagnostics - the incremental program optimizes this by only checking changed files
  const diagnostics = [
    ...builderProgram.getSyntacticDiagnostics(),
    ...builderProgram.getSemanticDiagnostics(),
    ...builderProgram.getGlobalDiagnostics(),
  ];

  // Emit the build info file to persist the incremental state
  builderProgram.emit();

  // Convert diagnostics to our format
  const problems: Problem[] = [];

  for (const diagnostic of diagnostics) {
    if (!diagnostic.file) continue;

    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start!,
    );
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );

    if (diagnostic.category !== ts.DiagnosticCategory.Error) {
      continue;
    }

    // Extract the problematic line with context
    const sourceLines = diagnostic.file.getFullText().split(/\r?\n/);
    const lineBefore = line > 0 ? sourceLines[line - 1] : "";
    const problematicLine = sourceLines[line] || "";
    const lineAfter =
      line < sourceLines.length - 1 ? sourceLines[line + 1] : "";

    let snippet = "";
    if (lineBefore) snippet += lineBefore + "\n";
    snippet += problematicLine + " // <-- TypeScript compiler error here\n";
    if (lineAfter) snippet += lineAfter;

    problems.push({
      file: normalizePath(path.relative(appPath, diagnostic.file.fileName)),
      line: line + 1, // Convert to 1-based
      column: character + 1, // Convert to 1-based
      message,
      code: diagnostic.code,
      snippet: snippet.trim(),
    });
  }

  return {
    problems,
  };
}

function createVirtualCompilerHost(
  ts: typeof import("typescript"),
  appPath: string,
  vfs: SyncVirtualFileSystem,
  compilerOptions: import("typescript").CompilerOptions,
): import("typescript").CompilerHost {
  const host = ts.createIncrementalCompilerHost(compilerOptions);

  // Override file reading to use virtual files
  host.readFile = (fileName: string) => {
    return vfs.readFile(fileName);
  };

  // Override file existence check
  host.fileExists = (fileName: string) => {
    return vfs.fileExists(fileName);
  };

  // Override getCurrentDirectory to ensure proper resolution
  host.getCurrentDirectory = () => appPath;

  // Override writeFile to handle virtual file system
  // This is important for writing the tsBuildInfo file
  const originalWriteFile = host.writeFile;
  host.writeFile = (
    fileName: string,
    data: string,
    writeByteOrderMark?: boolean,
    onError?: (message: string) => void,
  ) => {
    // Only write build info files to disk, not emit files
    if (fileName.endsWith(".tsbuildinfo")) {
      originalWriteFile?.call(
        host,
        fileName,
        data,
        !!writeByteOrderMark,
        onError,
      );
    }
    // Ignore other emit files since we're only doing type checking
  };

  return host;
}

function isTypeScriptFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx"].includes(ext);
}

async function processTypeScriptCheck(
  input: WorkerInput,
): Promise<WorkerOutput> {
  try {
    const { appPath, virtualChanges, tsBuildInfoCacheDir } = input;
    const ts = loadTypeScript(appPath);

    const vfs = new SyncVirtualFileSystemImpl(appPath, {
      fileExists: (fileName: string) => ts.sys.fileExists(fileName),
      readFile: (fileName: string) => ts.sys.readFile(fileName),
    });
    vfs.applyResponseChanges(virtualChanges);

    const tsconfigPath = resolveTsConfigPath(appPath);
    if (tsconfigPath == null) {
      console.info(
        `[tsc-worker] skip: no tsconfig in ${appPath} (expected one of: ${TS_CONFIG_CANDIDATES.join(", ")}); returning no problems`,
      );
      return {
        success: true,
        data: { problems: [] },
      };
    }

    // Create TypeScript program with virtual file system
    const result = await runTypeScriptCheck(ts, vfs, {
      appPath,
      tsconfigPath,
      tsBuildInfoCacheDir,
    });

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Handle messages from main thread
parentPort?.on("message", async (input: WorkerInput) => {
  const output = await processTypeScriptCheck(input);
  parentPort?.postMessage(output);
});

/**
 * Normalize the path to use forward slashes instead of backslashes.
 * This is important to prevent weird Git issues, particularly on Windows.
 * @param path Source path.
 * @returns Normalized path.
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
