export interface Template {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  githubUrl?: string;
  demoUrl?: string; // Live demo URL
  category?: 'frontend' | 'backend' | 'fullstack' | 'mobile' | 'api' | 'cli'; // Template category
  techStack?: string[]; // Technologies used (e.g., ["Next.js", "TypeScript", "Tailwind"])
  difficulty?: 'beginner' | 'intermediate' | 'advanced'; // Skill level required
  stars?: number; // GitHub stars (if from GitHub)
  lastUpdated?: string; // Last commit date (ISO string)
  isOfficial: boolean;
  isExperimental?: boolean;
  requiresNeon?: boolean;
  /** CLI command to scaffold the project (preferred over git clone) */
  cliCommand?: string;
  /** Command to run after scaffolding (e.g., "npm install") */
  postInstall?: string;
}

// ============================================
// CLI TEMPLATE CATALOG
// ============================================

/**
 * CLI-first templates using official scaffolding commands
 * {path} will be replaced with the workspace path
 */
export const CLI_TEMPLATES: Record<string, { command: string; postInstall?: string; description: string }> = {
  // ── Frontend ──────────────────────────────
  'react-vite-ts': {
    command: 'npm create vite@latest {path} -- --template react-ts',
    postInstall: 'npm install',
    description: 'React + Vite + TypeScript (recommended)',
  },
  'react-vite-js': {
    command: 'npm create vite@latest {path} -- --template react',
    postInstall: 'npm install',
    description: 'React + Vite (JavaScript)',
  },
  'vue-vite-ts': {
    command: 'npm create vite@latest {path} -- --template vue-ts',
    postInstall: 'npm install',
    description: 'Vue 3 + Vite + TypeScript',
  },
  'svelte-vite-ts': {
    command: 'npm create vite@latest {path} -- --template svelte-ts',
    postInstall: 'npm install',
    description: 'Svelte + Vite + TypeScript',
  },
  'preact-vite-ts': {
    command: 'npm create vite@latest {path} -- --template preact-ts',
    postInstall: 'npm install',
    description: 'Preact + Vite + TypeScript',
  },
  'solid-vite-ts': {
    command: 'npm create vite@latest {path} -- --template solid-ts',
    postInstall: 'npm install',
    description: 'SolidJS + Vite + TypeScript',
  },
  'lit-vite-ts': {
    command: 'npm create vite@latest {path} -- --template lit-ts',
    postInstall: 'npm install',
    description: 'Lit + Vite + TypeScript (Web Components)',
  },

  // ── Fullstack ──────────────────────────────
  'nextjs-app': {
    command: 'npx create-next-app@latest {path} --typescript --tailwind --eslint --app --src-dir --use-npm --no-git',
    description: 'Next.js 14 App Router + TypeScript + Tailwind',
  },
  'nextjs-pages': {
    command: 'npx create-next-app@latest {path} --typescript --tailwind --eslint --no-app --use-npm --no-git',
    description: 'Next.js Pages Router + TypeScript + Tailwind',
  },
  'nuxt': {
    command: 'npx nuxi@latest init {path} --no-git',
    postInstall: 'npm install',
    description: 'Nuxt 3 (Vue fullstack framework)',
  },
  'astro': {
    command: 'npm create astro@latest {path} -- --template minimal --no-git --no-install',
    postInstall: 'npm install',
    description: 'Astro (content-focused framework)',
  },
  'astro-blog': {
    command: 'npm create astro@latest {path} -- --template blog --no-git --no-install',
    postInstall: 'npm install',
    description: 'Astro Blog Template',
  },
  'remix': {
    command: 'npx create-remix@latest {path} --template remix-run/indie-stack --no-git',
    postInstall: 'npm install',
    description: 'Remix Indie Stack (Tailwind + Prisma + SQLite)',
  },
  'sveltekit': {
    command: 'npx create-svelte@latest {path} --template skeleton --types typescript',
    postInstall: 'npm install',
    description: 'SvelteKit + TypeScript',
  },

  // ── Backend ──────────────────────────────
  'express-ts': {
    command: 'npx create-express-app@latest {path} --typescript',
    postInstall: 'npm install',
    description: 'Express.js + TypeScript',
  },
  'nest': {
    command: 'npx @nestjs/cli new {path} --package-manager npm --skip-git',
    description: 'NestJS (Enterprise Node.js framework)',
  },
  'fastify': {
    command: 'npx @fastify/create-fastify@latest {path}',
    postInstall: 'npm install',
    description: 'Fastify (high-performance backend)',
  },
  'hono': {
    command: 'npm create hono@latest {path}',
    postInstall: 'npm install',
    description: 'Hono (ultrafast, edge-ready)',
  },

  // ── Mobile ──────────────────────────────
  'expo': {
    command: 'npx create-expo-app@latest {path} --template blank-typescript',
    description: 'Expo (React Native) + TypeScript',
  },
  'react-native': {
    command: 'npx react-native init {path} --template react-native-template-typescript',
    description: 'React Native CLI + TypeScript',
  },

  // ── Desktop ──────────────────────────────
  'electron-vite': {
    command: 'npm create @electron-forge/app@latest {path} -- --template=vite',
    postInstall: 'npm install',
    description: 'Electron + Vite',
  },
  'tauri': {
    command: 'npm create tauri-app@latest {path} -- --template vanilla-ts --manager npm --beta',
    postInstall: 'npm install',
    description: 'Tauri (Rust desktop with web frontend)',
  },

  // ── Utilities ──────────────────────────────
  'typescript-lib': {
    command: 'npx create-typescript-lib@latest {path}',
    description: 'TypeScript library starter',
  },
  'cli': {
    command: 'npx create-clack@latest {path}',
    description: 'CLI app with Clack (beautiful prompts)',
  },

  // ── Languages / Ecosystems ──────────────────────────────
  'go-module': {
    command: 'mkdir -p {path} && cd {path} && go mod init example.com/app && go mod tidy',
    description: 'Go module (go.mod) bootstrap',
  },
  'rust-bin': {
    command: 'cargo init --bin {path}',
    description: 'Rust executable crate (Cargo)',
  },
  'csharp-console': {
    command: 'dotnet new console --output {path} --name App',
    description: 'C# console app (.NET)',
  },
  'csharp-webapi': {
    command: 'dotnet new webapi --output {path} --name App',
    description: 'C# Web API (ASP.NET)',
  },
  'ruby-bundler': {
    command: 'mkdir -p {path} && cd {path} && bundle init',
    description: 'Ruby project (Gemfile) bootstrap',
  },
  'rails': {
    command: 'rails new {path}',
    description: 'Ruby on Rails application',
  },
  'php-composer': {
    command: 'mkdir -p {path} && cd {path} && composer init',
    description: 'PHP project (Composer) bootstrap',
  },
  'laravel': {
    command: 'composer create-project laravel/laravel {path}',
    description: 'Laravel application',
  },
  'swift-package-exec': {
    command: 'mkdir -p {path} && cd {path} && swift package init --type executable',
    description: 'Swift package (executable) bootstrap',
  },
  'elixir': {
    command: 'mix new {path}',
    description: 'Elixir application bootstrap',
  },
  'phoenix': {
    command: 'mix phx.new {path}',
    description: 'Phoenix web application',
  },
};

export const DEFAULT_TEMPLATE_ID = "react-vite-ts";
export const DEFAULT_TEMPLATE = {
  id: "react-vite-ts",
  title: "React + Vite + TypeScript",
  description: "Modern React app with Vite, TypeScript, and hot reload.",
  imageUrl:
    "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
  isOfficial: true,
  cliCommand: CLI_TEMPLATES['react-vite-ts'].command,
  postInstall: CLI_TEMPLATES['react-vite-ts'].postInstall,
};

const PORTAL_MINI_STORE_ID = "portal-mini-store";
export const NEON_TEMPLATE_IDS = new Set<string>([PORTAL_MINI_STORE_ID]);

export const localTemplatesData: Template[] = [
  // ── CLI Templates (Recommended) ──────────────────────────────
  {
    ...DEFAULT_TEMPLATE,
    category: 'frontend',
    techStack: ['React', 'Vite', 'TypeScript'],
    difficulty: 'beginner',
  },
  {
    id: "nextjs-app",
    title: "Next.js 14 App Router",
    description: "Full-stack React with App Router, TypeScript, and Tailwind.",
    imageUrl: "https://github.com/user-attachments/assets/96258e4f-abce-4910-a62a-a9dff77965f2",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['nextjs-app'].command,
    category: 'fullstack',
    techStack: ['Next.js', 'React', 'TypeScript', 'Tailwind'],
    difficulty: 'intermediate',
  },
  {
    id: "vue-vite-ts",
    title: "Vue 3 + Vite + TypeScript",
    description: "Modern Vue 3 app with Composition API and Vite.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['vue-vite-ts'].command,
    postInstall: CLI_TEMPLATES['vue-vite-ts'].postInstall,
    category: 'frontend',
    techStack: ['Vue', 'Vite', 'TypeScript'],
    difficulty: 'beginner',
  },
  {
    id: "svelte-vite-ts",
    title: "Svelte + Vite + TypeScript",
    description: "Blazing fast Svelte with Vite and TypeScript.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['svelte-vite-ts'].command,
    postInstall: CLI_TEMPLATES['svelte-vite-ts'].postInstall,
    category: 'frontend',
    techStack: ['Svelte', 'Vite', 'TypeScript'],
    difficulty: 'beginner',
  },
  {
    id: "astro",
    title: "Astro",
    description: "Content-focused framework for blazing fast websites.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['astro'].command,
    postInstall: CLI_TEMPLATES['astro'].postInstall,
    category: 'fullstack',
    techStack: ['Astro', 'TypeScript'],
    difficulty: 'beginner',
  },
  {
    id: "nuxt",
    title: "Nuxt 3",
    description: "Vue fullstack framework with file-based routing.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['nuxt'].command,
    postInstall: CLI_TEMPLATES['nuxt'].postInstall,
    category: 'fullstack',
    techStack: ['Nuxt', 'Vue', 'TypeScript'],
    difficulty: 'intermediate',
  },
  {
    id: "nest",
    title: "NestJS",
    description: "Enterprise-grade Node.js backend framework.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['nest'].command,
    category: 'backend',
    techStack: ['NestJS', 'TypeScript'],
    difficulty: 'intermediate',
  },
  {
    id: "expo",
    title: "Expo (React Native)",
    description: "Cross-platform mobile app with Expo and TypeScript.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['expo'].command,
    category: 'mobile',
    techStack: ['Expo', 'React Native', 'TypeScript'],
    difficulty: 'intermediate',
  },
  {
    id: "go-module",
    title: "Go Module",
    description: "Start a Go project with go.mod and a clean baseline.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['go-module'].command,
    category: 'backend',
    techStack: ['Go'],
    difficulty: 'beginner',
  },
  {
    id: "rust-bin",
    title: "Rust Executable (Cargo)",
    description: "Start a Rust project with Cargo and a binary crate.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['rust-bin'].command,
    category: 'backend',
    techStack: ['Rust'],
    difficulty: 'beginner',
  },
  {
    id: "csharp-webapi",
    title: "C# Web API (ASP.NET)",
    description: "ASP.NET Web API starter via dotnet CLI.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['csharp-webapi'].command,
    category: 'api',
    techStack: ['C#', '.NET', 'ASP.NET'],
    difficulty: 'beginner',
  },
  {
    id: "ruby-bundler",
    title: "Ruby (Bundler)",
    description: "Ruby project bootstrap with Gemfile.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['ruby-bundler'].command,
    category: 'backend',
    techStack: ['Ruby'],
    difficulty: 'beginner',
  },
  {
    id: "laravel",
    title: "Laravel",
    description: "Laravel application via Composer.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['laravel'].command,
    category: 'fullstack',
    techStack: ['PHP', 'Laravel'],
    difficulty: 'beginner',
  },
  {
    id: "swift-package-exec",
    title: "Swift Package (Executable)",
    description: "SwiftPM executable starter.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['swift-package-exec'].command,
    category: 'cli',
    techStack: ['Swift', 'SwiftPM'],
    difficulty: 'beginner',
  },
  {
    id: "elixir",
    title: "Elixir",
    description: "Elixir application starter via mix.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['elixir'].command,
    category: 'backend',
    techStack: ['Elixir'],
    difficulty: 'beginner',
  },
  {
    id: "electron-vite",
    title: "Electron + Vite",
    description: "Desktop app with Electron and Vite for fast dev.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['electron-vite'].command,
    postInstall: CLI_TEMPLATES['electron-vite'].postInstall,
    category: 'frontend',
    techStack: ['Electron', 'Vite', 'TypeScript'],
    difficulty: 'intermediate',
  },
  {
    id: "tauri",
    title: "Tauri",
    description: "Lightweight desktop apps with Rust backend.",
    imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    cliCommand: CLI_TEMPLATES['tauri'].command,
    postInstall: CLI_TEMPLATES['tauri'].postInstall,
    category: 'frontend',
    techStack: ['Tauri', 'Rust', 'TypeScript'],
    difficulty: 'advanced',
  },
  // ── GitHub Templates (Fallback to ZIP) ──────────────────────────────
  {
    id: PORTAL_MINI_STORE_ID,
    title: "Portal: Mini Store Template",
    description: "Uses Neon DB, Payload CMS, Next.js",
    imageUrl:
      "https://github.com/user-attachments/assets/ed86f322-40bf-4fd5-81dc-3b1d8a16e12b",
    /** Upstream template repo (`@dyad-sh`); override if you publish a fork. */
    githubUrl: "https://github.com/dyad-sh/portal-mini-store-template",
    isOfficial: true,
    isExperimental: true,
    requiresNeon: true,
    category: 'fullstack',
    techStack: ['Next.js', 'Neon', 'Payload CMS', 'TypeScript'],
    difficulty: 'advanced',
  },
];
