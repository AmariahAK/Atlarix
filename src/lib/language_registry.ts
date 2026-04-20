/**
 * Atlarix Language Registry
 * =========================
 * Defines supported programming languages/runtimes with check commands,
 * version commands, and install URLs for lazy validation.
 */

export interface LanguageRequirement {
    /** Unique identifier for the language */
    name: string;
    /** Display name for UI */
    displayName: string;
    /** Command to check if installed (returns exit 0 if installed) */
    checkCommand: string;
    /** Command to get version (optional, defaults to checkCommand) */
    versionCommand?: string;
    /** URL to download/install */
    installUrl: string;
    /** Icon/emoji for UI */
    icon: string;
    /** File indicators that suggest this language is used */
    indicators: string[];
    /** Package manager commands (optional) */
    packageManager?: {
        install: string;
        run: string;
    };
}

/**
 * Registry of all supported languages/runtimes
 */
export const LANGUAGE_REGISTRY: Record<string, LanguageRequirement> = {
    nodejs: {
        name: 'nodejs',
        displayName: 'Node.js',
        checkCommand: 'node --version',
        versionCommand: 'node --version',
        installUrl: 'https://nodejs.org',
        icon: '🟢',
        indicators: ['package.json', 'node_modules', '.nvmrc', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
        packageManager: {
            install: 'npm install',
            run: 'npm run',
        },
    },
    python: {
        name: 'python',
        displayName: 'Python',
        checkCommand: 'python3 --version || python --version',
        versionCommand: 'python3 --version || python --version',
        installUrl: 'https://python.org',
        icon: '🐍',
        indicators: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'poetry.lock', '.python-version', 'venv', '__pycache__'],
        packageManager: {
            install: 'pip install -r requirements.txt',
            run: 'python',
        },
    },
    go: {
        name: 'go',
        displayName: 'Go',
        checkCommand: 'go version',
        versionCommand: 'go version',
        installUrl: 'https://go.dev',
        icon: '🔷',
        indicators: ['go.mod', 'go.sum', 'main.go'],
        packageManager: {
            install: 'go mod download',
            run: 'go run',
        },
    },
    rust: {
        name: 'rust',
        displayName: 'Rust',
        checkCommand: 'rustc --version',
        versionCommand: 'rustc --version',
        installUrl: 'https://rustup.rs',
        icon: '🦀',
        indicators: ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'src/lib.rs'],
        packageManager: {
            install: 'cargo build',
            run: 'cargo run',
        },
    },
    ruby: {
        name: 'ruby',
        displayName: 'Ruby',
        checkCommand: 'ruby --version',
        versionCommand: 'ruby --version',
        installUrl: 'https://www.ruby-lang.org',
        icon: '💎',
        indicators: ['Gemfile', 'Gemfile.lock', '.ruby-version', 'Rakefile', '*.rb'],
        packageManager: {
            install: 'bundle install',
            run: 'ruby',
        },
    },
    java: {
        name: 'java',
        displayName: 'Java',
        checkCommand: 'java --version',
        versionCommand: 'java --version',
        installUrl: 'https://adoptium.net',
        icon: '☕',
        indicators: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'mvnw', 'gradlew', 'src/main/java'],
        packageManager: {
            install: 'mvn install',
            run: 'java -jar',
        },
    },
    php: {
        name: 'php',
        displayName: 'PHP',
        checkCommand: 'php --version',
        versionCommand: 'php --version',
        installUrl: 'https://www.php.net',
        icon: '🐘',
        indicators: ['composer.json', 'composer.lock', 'artisan', 'index.php', 'vendor'],
        packageManager: {
            install: 'composer install',
            run: 'php',
        },
    },
    dotnet: {
        name: 'dotnet',
        displayName: '.NET',
        checkCommand: 'dotnet --version',
        versionCommand: 'dotnet --version',
        installUrl: 'https://dotnet.microsoft.com',
        icon: '🔵',
        indicators: ['*.csproj', '*.fsproj', '*.sln', 'Program.cs', 'appsettings.json'],
        packageManager: {
            install: 'dotnet restore',
            run: 'dotnet run',
        },
    },
    deno: {
        name: 'deno',
        displayName: 'Deno',
        checkCommand: 'deno --version',
        versionCommand: 'deno --version',
        installUrl: 'https://deno.land',
        icon: '🦕',
        indicators: ['deno.json', 'deno.jsonc', 'deno.lock', 'deps.ts', 'mod.ts'],
        packageManager: {
            install: 'deno cache deps.ts',
            run: 'deno run',
        },
    },
    bun: {
        name: 'bun',
        displayName: 'Bun',
        checkCommand: 'bun --version',
        versionCommand: 'bun --version',
        installUrl: 'https://bun.sh',
        icon: '🥟',
        indicators: ['bun.lockb', 'bunfig.toml'],
        packageManager: {
            install: 'bun install',
            run: 'bun run',
        },
    },
    swift: {
        name: 'swift',
        displayName: 'Swift',
        checkCommand: 'swift --version',
        versionCommand: 'swift --version',
        installUrl: 'https://www.swift.org/download/',
        icon: '🕊️',
        indicators: ['Package.swift', '.swiftpm', 'Sources', '*.swift'],
        packageManager: {
            install: 'swift package resolve',
            run: 'swift run',
        },
    },
    elixir: {
        name: 'elixir',
        displayName: 'Elixir',
        checkCommand: 'elixir --version',
        versionCommand: 'elixir --version',
        installUrl: 'https://elixir-lang.org',
        icon: '💜',
        indicators: ['mix.exs', 'mix.lock'],
        packageManager: {
            install: 'mix deps.get',
            run: 'mix run',
        },
    },
    docker: {
        name: 'docker',
        displayName: 'Docker',
        checkCommand: 'docker --version',
        versionCommand: 'docker --version',
        installUrl: 'https://www.docker.com',
        icon: '🐳',
        indicators: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore'],
    },
};

/**
 * Get language by name
 */
export function getLanguage(name: string): LanguageRequirement | undefined {
    return LANGUAGE_REGISTRY[name.toLowerCase()];
}

/**
 * Get all language names
 */
export function getAllLanguageNames(): string[] {
    return Object.keys(LANGUAGE_REGISTRY);
}

/**
 * Check if a file indicator matches any language
 */
export function detectLanguageFromFile(filename: string): string[] {
    const matches: string[] = [];

    for (const [langName, lang] of Object.entries(LANGUAGE_REGISTRY)) {
        for (const indicator of lang.indicators) {
            // Handle glob patterns like *.csproj
            if (indicator.startsWith('*')) {
                const ext = indicator.slice(1);
                if (filename.endsWith(ext)) {
                    matches.push(langName);
                    break;
                }
            } else if (filename === indicator || filename.endsWith('/' + indicator)) {
                matches.push(langName);
                break;
            }
        }
    }

    return matches;
}
