import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { getEnvVar } from "@/ipc/utils/read_env";
import { getMonacoLanguageForPath } from "@/lib/monaco/language-manifest";
export {
  isLspLanguageSupported,
  LSP_SUPPORTED_LANGUAGES,
} from "@/lib/lsp/lsp-supported-languages";


export interface LspServerConfig {
  id: string;
  language: string[];
  command: string[];
  rootMarkers: string[];
  /** When set, prefer this binary from app or workspace node_modules/.bin */
  bundledBin?: string;
  binaryCheck?: (workspacePath: string) => Promise<boolean>;
}

export type ResolvedLspCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  useElectronNode: boolean;
};

function appBinCandidates(binName: string): string[] {
  const roots = [
    app.getAppPath(),
    path.join(app.getAppPath(), ".."),
    process.cwd(),
  ];
  const out: string[] = [];
  for (const root of roots) {
    out.push(path.join(root, "node_modules", ".bin", binName));
    if (process.platform === "win32") {
      out.push(path.join(root, "node_modules", ".bin", `${binName}.cmd`));
    }
  }
  return out;
}

function workspaceBinPath(workspacePath: string, binName: string): string | null {
  const p = path.join(workspacePath, "node_modules", ".bin", binName);
  if (fs.existsSync(p)) return p;
  if (process.platform === "win32") {
    const cmd = `${p}.cmd`;
    if (fs.existsSync(cmd)) return cmd;
  }
  return null;
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function whichBinary(name: string): Promise<string | null> {
  try {
    const pathFromShell = getEnvVar("PATH");
    const env = pathFromShell
      ? { ...process.env, PATH: pathFromShell }
      : { ...process.env };
    const result = await new Promise<string>((resolve, reject) => {
      execFile("which", [name], { timeout: 2000, env }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    return result || null;
  } catch {
    return null;
  }
}

function isNodeScript(binPath: string): boolean {
  try {
    const head = fs.readFileSync(binPath, "utf8").slice(0, 256);
    return head.startsWith("#!") && /node/.test(head);
  } catch {
    return binPath.endsWith(".js");
  }
}

function lspSpawnEnv(): NodeJS.ProcessEnv {
  let env = { ...process.env };
  try {
    const pathVar = getEnvVar("PATH");
    if (pathVar) env = { ...env, PATH: pathVar };
  } catch {
    /* ignore */
  }
  return env;
}

export async function resolveServerCommand(
  config: LspServerConfig,
  workspacePath: string,
): Promise<ResolvedLspCommand | null> {
  const env = lspSpawnEnv();
  const args = config.command.slice(1);

  if (config.id === "typescript") {
    const wsTls = workspaceBinPath(workspacePath, "typescript-language-server");
    const bundled = config.bundledBin
      ? firstExisting(appBinCandidates(config.bundledBin))
      : null;
    const bin = wsTls ?? bundled ?? (await whichBinary("typescript-language-server"));
    if (!bin) return null;
    const script = isNodeScript(bin);
    return {
      command: script ? process.execPath : bin,
      args: script ? [bin, ...args] : args,
      env: script ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
      useElectronNode: script,
    };
  }

  if (config.bundledBin) {
    const bundled = firstExisting(appBinCandidates(config.bundledBin));
    if (bundled) {
      const script = isNodeScript(bundled);
      if (script) {
        return {
          command: process.execPath,
          args: [bundled, ...args],
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          useElectronNode: true,
        };
      }
      return { command: bundled, args, env, useElectronNode: false };
    }
  }

  const external = config.command[0];
  const resolved = await whichBinary(external);
  if (!resolved) return null;
  return { command: resolved, args, env, useElectronNode: false };
}

export async function checkBinaryAvailable(
  binary: string,
  workspacePath: string,
): Promise<boolean> {
  if (binary === "typescript-language-server") {
    return Boolean(
      workspaceBinPath(workspacePath, "typescript-language-server") ??
        firstExisting(appBinCandidates("typescript-language-server")) ??
        (await whichBinary("typescript-language-server")),
    );
  }
  const bundled = firstExisting(appBinCandidates(binary));
  if (bundled) return true;
  return Boolean(await whichBinary(binary));
}

export async function findServerForWorkspace(
  workspacePath: string,
  language: string,
): Promise<LspServerConfig | null> {
  const configs = LSP_SERVERS.filter((s) => s.language.includes(language));

  for (const config of configs) {
    if (config.binaryCheck) {
      const available = await config.binaryCheck(workspacePath);
      if (available) return config;
    } else {
      const bin = config.bundledBin ?? config.command[0];
      const available = await checkBinaryAvailable(bin, workspacePath);
      if (available) return config;
    }
  }
  return null;
}

export function findNearestRoot(
  filePath: string,
  workspaceRoot: string,
  rootMarkers: string[],
): string {
  let current = path.dirname(filePath);
  const stopAt = workspaceRoot;

  while (current && current !== stopAt && current !== path.dirname(current)) {
    for (const marker of rootMarkers) {
      const markerPath = path.join(current, marker);
      if (fs.existsSync(markerPath)) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return workspaceRoot;
}

export const LSP_SERVERS: LspServerConfig[] = [
  {
    id: "typescript",
    language: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    command: ["typescript-language-server", "--stdio"],
    bundledBin: "typescript-language-server",
    rootMarkers: ["package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lockb"],
    binaryCheck: async (workspacePath) =>
      checkBinaryAvailable("typescript-language-server", workspacePath),
  },
  {
    id: "python",
    language: ["python"],
    command: ["pyright-langserver", "--stdio"],
    rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", "poetry.lock"],
  },
  {
    id: "python-pylsp",
    language: ["python"],
    command: ["pylsp"],
    rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", "poetry.lock"],
  },
  {
    id: "rust",
    language: ["rust"],
    command: ["rust-analyzer"],
    rootMarkers: ["Cargo.toml", "Cargo.lock"],
  },
  {
    id: "go",
    language: ["go"],
    command: ["gopls", "serve"],
    rootMarkers: ["go.mod", "go.sum"],
  },
  {
    id: "java",
    language: ["java"],
    command: ["jdtls"],
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
  },
  {
    id: "kotlin",
    language: ["kotlin"],
    command: ["kotlin-language-server"],
    rootMarkers: ["build.gradle.kts", "pom.xml", "settings.gradle.kts"],
  },
  {
    id: "clangd",
    language: ["c", "cpp", "objective-c", "objective-cpp"],
    command: ["clangd"],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd", "compile_flags.txt"],
  },
  {
    id: "csharp",
    language: ["csharp"],
    command: ["OmniSharp", "--languageserver"],
    rootMarkers: ["*.csproj", "*.sln", "omnisharp.json"],
  },
  {
    id: "ruby",
    language: ["ruby"],
    command: ["solargraph", "stdio"],
    rootMarkers: ["Gemfile", ".ruby-version"],
  },
  {
    id: "php",
    language: ["php"],
    command: ["intelephense", "--stdio"],
    rootMarkers: ["composer.json"],
  },
  {
    id: "swift",
    language: ["swift"],
    command: ["sourcekit-lsp"],
    rootMarkers: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
  },
  {
    id: "lua",
    language: ["lua"],
    command: ["lua-language-server"],
    rootMarkers: [".luarc.json", "luacheck", ".lua"],
  },
  {
    id: "bash",
    language: ["bash", "shell"],
    command: ["bash-language-server", "start"],
    rootMarkers: [".bashrc", ".bash_profile", ".sh"],
  },
  {
    id: "html",
    language: ["html"],
    command: ["vscode-html-language-server", "--stdio"],
    bundledBin: "vscode-html-language-server",
    rootMarkers: ["index.html", "*.html"],
  },
  {
    id: "css",
    language: ["css", "scss", "sass", "less"],
    command: ["vscode-css-language-server", "--stdio"],
    bundledBin: "vscode-css-language-server",
    rootMarkers: ["*.css", "*.scss", "*.sass", "*.less", "style.css"],
  },
  {
    id: "json",
    language: ["json"],
    command: ["vscode-json-language-server", "--stdio"],
    bundledBin: "vscode-json-language-server",
    rootMarkers: ["*.json", "tsconfig.json", "package.json"],
  },
  {
    id: "yaml",
    language: ["yaml"],
    command: ["yaml-language-server", "--stdio"],
    rootMarkers: ["*.yaml", "*.yml"],
  },
  {
    id: "toml",
    language: ["toml"],
    command: ["taplo", "lsp", "stdio"],
    rootMarkers: ["*.toml"],
  },
  {
    id: "graphql",
    language: ["graphql"],
    command: ["graphql-lsp", "server", "-m", "stream"],
    rootMarkers: [".graphqlrc", "graphql.config.js", "*.graphql"],
  },
  {
    id: "dockerfile",
    language: ["dockerfile"],
    command: ["docker-langserver", "--stdio"],
    rootMarkers: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml"],
  },
  {
    id: "vue",
    language: ["vue"],
    command: ["vue-language-server", "--stdio"],
    rootMarkers: ["package.json", "vue.config.js"],
  },
  {
    id: "svelte",
    language: ["svelte"],
    command: ["svelte-language-server", "--stdio"],
    rootMarkers: ["svelte.config.js", "*.svelte"],
  },
];

export function getLanguageFromFile(filePath: string): string {
  return getMonacoLanguageForPath(filePath);
}
