import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import log from "electron-log";

const logger = log.scope("lsp-server-registry");

export interface LspServerConfig {
  id: string;
  language: string[];
  command: string[];
  rootMarkers: string[];
  binaryCheck?: (workspacePath: string) => Promise<boolean>;
}

export async function checkBinaryAvailable(
  binary: string,
  workspacePath: string
): Promise<boolean> {
  if (binary === "node") {
    const tsserverPath = path.join(workspacePath, "node_modules/.bin/tsserver");
    return fs.existsSync(tsserverPath);
  }

  if (binary === "pyright-langserver" || binary === "pylsp") {
    try {
      await execFile("which", [binary], { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  try {
    await execFile("which", [binary], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export async function findServerForWorkspace(
  workspacePath: string,
  language: string
): Promise<LspServerConfig | null> {
  const configs = LSP_SERVERS.filter((s) => s.language.includes(language));

  for (const config of configs) {
    if (config.binaryCheck) {
      const available = await config.binaryCheck(workspacePath);
      if (available) return config;
    } else {
      const available = await checkBinaryAvailable(config.command[0], workspacePath);
      if (available) return config;
    }
  }
  return null;
}

export function findNearestRoot(
  filePath: string,
  workspaceRoot: string,
  rootMarkers: string[]
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
    command: ["node", "node_modules/.bin/tsserver", "--stdio"],
    rootMarkers: ["package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lockb"],
    binaryCheck: async (workspacePath: string) => {
      const tsserverPath = path.join(workspacePath, "node_modules/.bin/tsserver");
      return fs.existsSync(tsserverPath);
    },
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
    command: ["pylsp", "--stdio"],
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
    rootMarkers: ["index.html", "*.html"],
  },
  {
    id: "css",
    language: ["css", "scss", "sass", "less"],
    command: ["vscode-css-language-server", "--stdio"],
    rootMarkers: ["*.css", "*.scss", "*.sass", "*.less", "style.css"],
  },
  {
    id: "json",
    language: ["json"],
    command: ["vscode-json-language-server", "--stdio"],
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
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".scala": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".lua": "lua",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "css",
    ".sass": "css",
    ".less": "css",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".dockerfile": "dockerfile",
    ".vue": "vue",
    ".svelte": "svelte",
  };
  return langMap[ext] || "plaintext";
}