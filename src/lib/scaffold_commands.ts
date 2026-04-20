/**
 * Scaffold Commands Library
 * =========================
 * Defines official CLI commands for scaffolding various frameworks.
 * The AI references this to prefer CLI scaffolding over manual file creation.
 */

export interface ScaffoldCommand {
    /** The CLI command to run */
    cli: string;
    /** Human-readable description */
    description: string;
    /** Commands to run after scaffolding (e.g., install deps) */
    postInstall?: string[];
    /** Whether the command is interactive (may need flags to skip) */
    interactive?: boolean;
    /** Alternative command for non-interactive mode */
    nonInteractiveCli?: string;
}

/**
 * Official CLI scaffolding commands by framework
 */
export const SCAFFOLD_COMMANDS: Record<string, ScaffoldCommand> = {
    // Frontend Frameworks
    "react": {
        cli: "npx create-vite@latest . --template react-ts",
        description: "React with Vite and TypeScript",
    },
    "react-vite": {
        cli: "npx create-vite@latest . --template react-ts",
        description: "React with Vite and TypeScript",
    },
    "nextjs": {
        cli: "npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias '@/*'",
        description: "Next.js with App Router, TypeScript, Tailwind",
        nonInteractiveCli: "npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias '@/*' --yes",
    },
    "vue": {
        cli: "npx create-vue@latest .",
        description: "Vue.js with official create-vue",
        interactive: true,
    },
    "svelte": {
        cli: "npx sv create .",
        description: "Svelte with sv (official CLI)",
        interactive: true,
    },
    "sveltekit": {
        cli: "npx sv create . --template minimal",
        description: "SvelteKit minimal template",
    },
    "astro": {
        cli: "npm create astro@latest .",
        description: "Astro static site builder",
        interactive: true,
    },
    "remix": {
        cli: "npx create-remix@latest .",
        description: "Remix full-stack framework",
        interactive: true,
    },
    "solid": {
        cli: "npx degit solidjs/templates/ts .",
        description: "SolidJS with TypeScript",
    },
    "qwik": {
        cli: "npm create qwik@latest .",
        description: "Qwik resumable framework",
        interactive: true,
    },

    // Backend Frameworks
    "express": {
        cli: "npx express-generator . --no-view",
        description: "Express.js API backend",
        postInstall: ["npm install"],
    },
    "nestjs": {
        cli: "npx @nestjs/cli new . --skip-git --package-manager npm",
        description: "NestJS TypeScript backend",
    },
    "fastify": {
        cli: "npx fastify-cli generate . --esm",
        description: "Fastify fast web framework",
    },
    "hono": {
        cli: "npm create hono@latest .",
        description: "Hono ultrafast web framework",
        interactive: true,
    },
    "koa": {
        cli: "npx koa-generator .",
        description: "Koa.js minimalist backend",
        postInstall: ["npm install"],
    },

    // Full-Stack & Desktop
    "electron": {
        cli: "npx create-electron-app .",
        description: "Electron desktop app",
    },
    "tauri": {
        cli: "npm create tauri-app@latest .",
        description: "Tauri lightweight desktop app",
        interactive: true,
    },
    "expo": {
        cli: "npx create-expo-app .",
        description: "Expo React Native app",
    },
    "bun": {
        cli: "bun init",
        description: "Bun project (initializes package.json)",
    },
    "bun-vite-react": {
        cli: "bun create vite@latest . --template react-ts",
        description: "Bun + Vite + React + TypeScript",
    },
    "springboot": {
        cli: "curl -fsSL \"https://start.spring.io/starter.zip?type=maven-project&language=java&bootVersion=3.3.0&baseDir=.&groupId=com.example&artifactId=app&name=app&packageName=com.example.app&dependencies=web\" -o starter.zip && unzip -o starter.zip && rm starter.zip",
        description: "Spring Boot (Java) via Spring Initializr",
        interactive: false,
    },
    "kotlin-gradle": {
        cli: "gradle init --type kotlin-application --dsl kotlin",
        description: "Kotlin application (Gradle Kotlin DSL)",
        interactive: true,
    },
    "java-maven": {
        cli: "mvn -B archetype:generate -DgroupId=com.example -DartifactId=app -DarchetypeArtifactId=maven-archetype-quickstart -DarchetypeVersion=1.4 -DinteractiveMode=false",
        description: "Java application (Maven quickstart archetype)",
        interactive: false,
    },
    "react-native": {
        cli: "npx react-native init AppName",
        description: "React Native mobile app",
    },

    // ── Languages / Ecosystems (CLI bootstrap) ──────────────────────────────
    "go": {
        cli: "go mod init example.com/app",
        description: "Go module (go.mod) bootstrap",
        postInstall: ["go mod tidy"],
    },
    "rust": {
        cli: "cargo init --bin .",
        description: "Rust executable crate (Cargo)",
    },
    "csharp-console": {
        cli: "dotnet new console --name App",
        description: "C# console app (.NET)",
    },
    "csharp-webapi": {
        cli: "dotnet new webapi --name App",
        description: "C# Web API (ASP.NET)",
    },
    "ruby": {
        cli: "bundle init",
        description: "Ruby project (Gemfile) bootstrap",
    },
    "rails": {
        cli: "rails new .",
        description: "Ruby on Rails app",
        interactive: true,
    },
    "php-composer": {
        cli: "composer init",
        description: "PHP project (Composer) bootstrap",
        interactive: true,
    },
    "laravel": {
        cli: "composer create-project laravel/laravel .",
        description: "Laravel application",
    },
    "swift": {
        cli: "swift package init --type executable",
        description: "Swift package (executable) bootstrap",
    },
    "elixir": {
        cli: "mix new .",
        description: "Elixir application bootstrap",
    },
    "phoenix": {
        cli: "mix phx.new .",
        description: "Phoenix web application",
        interactive: true,
    },

    // Static Site Generators
    "gatsby": {
        cli: "npx gatsby new . --ts",
        description: "Gatsby static site generator",
    },
    "eleventy": {
        cli: "npx @11ty/eleventy --init",
        description: "Eleventy static site generator",
    },

    // Monorepo & Tooling
    "turborepo": {
        cli: "npx create-turbo@latest .",
        description: "Turborepo monorepo",
        interactive: true,
    },
    "nx": {
        cli: "npx create-nx-workspace@latest .",
        description: "Nx monorepo",
        interactive: true,
    },
};

/**
 * Get the CLI command for a framework
 */
export function getScaffoldCommand(framework: string): ScaffoldCommand | undefined {
    const normalizedKey = framework.toLowerCase().replace(/[^a-z]/g, '');
    return SCAFFOLD_COMMANDS[normalizedKey] || SCAFFOLD_COMMANDS[framework.toLowerCase()];
}

/**
 * Check if a framework has an official CLI
 */
export function hasOfficialCLI(framework: string): boolean {
    return !!getScaffoldCommand(framework);
}

/**
 * Get all available framework names
 */
export function getAvailableFrameworks(): string[] {
    return Object.keys(SCAFFOLD_COMMANDS);
}
