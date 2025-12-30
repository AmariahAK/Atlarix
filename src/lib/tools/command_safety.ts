/**
 * Command Safety Wrapper
 * ======================
 * Blocks dangerous terminal commands to protect user systems.
 * Full command approval modal deferred to v2.0/v3.0.
 * 
 * Safe commands (whitelist):
 * - git add, commit, push, pull, status, diff, log
 * - npm/yarn/pnpm install, run, build, test, start, dev
 * - Node version managers: nvm, n, fnm
 * 
 * Dangerous patterns (blocked):
 * - rm -rf, rm -r /
 * - sudo commands
 * - chmod 777
 * - curl/wget piped to bash
 * - Format/delete disk commands
 */

// Dangerous command patterns - these are BLOCKED
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    // Delete operations
    { pattern: /rm\s+(-rf?|--recursive)\s*[\/~]/i, reason: 'Recursively deletes files starting from root or home' },
    { pattern: /rm\s+-[a-z]*f[a-z]*\s+\//i, reason: 'Force deletion from root directory' },
    { pattern: /rmdir\s+--ignore-fail-on-non-empty\s+\//i, reason: 'Force removes directories from root' },

    // Privilege escalation
    { pattern: /^sudo\s+/i, reason: 'Requires system administrator privileges' },
    { pattern: /su\s+-?\s*$/i, reason: 'Switches to root user' },

    // Dangerous permissions
    { pattern: /chmod\s+777/i, reason: 'Sets world-writable permissions (security risk)' },
    { pattern: /chmod\s+-R\s+777/i, reason: 'Recursively sets dangerous permissions' },

    // Remote code execution
    { pattern: /curl\s+.*\|\s*(bash|sh|zsh)/i, reason: 'Downloads and executes remote code' },
    { pattern: /wget\s+.*\|\s*(bash|sh|zsh)/i, reason: 'Downloads and executes remote code' },
    { pattern: /curl\s+.*>\s*(\/|~)/i, reason: 'Downloads file to sensitive location' },

    // System destruction
    { pattern: /mkfs\./i, reason: 'Formats filesystem' },
    { pattern: /dd\s+if=.*of=\/dev\//i, reason: 'Writes directly to disk devices' },
    { pattern: /:\(\)\{\s*:\|:&\s*\};:/i, reason: 'Fork bomb - crashes system' },

    // Credential theft
    { pattern: /cat\s+.*\/etc\/passwd/i, reason: 'Reads system password file' },
    { pattern: /cat\s+.*\/etc\/shadow/i, reason: 'Reads system shadow file' },
    { pattern: /cat\s+.*\.ssh\/id_/i, reason: 'Exposes SSH private keys' },

    // Network attacks
    { pattern: /nc\s+-l\s+-p/i, reason: 'Opens network listener (potential backdoor)' },
    { pattern: /iptables\s+-F/i, reason: 'Flushes firewall rules' },
];

// Safe command prefixes - these are ALLOWED without extra scrutiny
const SAFE_COMMAND_PREFIXES = [
    // Git operations
    'git add', 'git commit', 'git push', 'git pull', 'git fetch',
    'git status', 'git diff', 'git log', 'git branch', 'git checkout',
    'git merge', 'git rebase', 'git stash', 'git reset', 'git clone',

    // Package managers
    'npm install', 'npm i', 'npm run', 'npm test', 'npm start',
    'npm build', 'npm dev', 'npm ci', 'npm update', 'npm outdated',
    'yarn add', 'yarn install', 'yarn run', 'yarn test', 'yarn start',
    'yarn build', 'yarn dev',
    'pnpm add', 'pnpm install', 'pnpm run', 'pnpm test', 'pnpm start',
    'pnpm build', 'pnpm dev',

    // Build tools
    'tsc', 'vite', 'next', 'nuxt', 'webpack', 'esbuild', 'rollup',
    'turbo', 'nx', 'lerna',

    // Linting/formatting
    'eslint', 'prettier', 'biome', 'oxlint',

    // Testing
    'jest', 'vitest', 'mocha', 'playwright', 'cypress',

    // Node version managers
    'nvm', 'fnm', 'volta',

    // Info commands (completely safe)
    'ls', 'pwd', 'echo', 'cat', 'which', 'whereis', 'whoami', 'date',
];

export interface CommandSafetyResult {
    isSafe: boolean;
    isTrusted: boolean; // Trusted = safe command from whitelist
    reason?: string;
    suggestion?: string;
}

/**
 * Check if a command is safe to execute
 */
export function checkCommandSafety(command: string): CommandSafetyResult {
    const trimmedCommand = command.trim();

    // Check for dangerous patterns first
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmedCommand)) {
            return {
                isSafe: false,
                isTrusted: false,
                reason: `⛔ BLOCKED: ${reason}`,
                suggestion: 'Please run this command directly in your terminal if you understand the risks.',
            };
        }
    }

    // Check if it's a trusted/safe command
    const lowerCommand = trimmedCommand.toLowerCase();
    const isTrusted = SAFE_COMMAND_PREFIXES.some(prefix =>
        lowerCommand.startsWith(prefix.toLowerCase())
    );

    return {
        isSafe: true,
        isTrusted,
        reason: isTrusted
            ? '✅ Safe command (whitelisted)'
            : '⚠️ Requires manual approval',
    };
}

/**
 * Get a user-friendly command description
 */
export function describeCommand(command: string): string {
    const trimmed = command.trim().toLowerCase();

    // Git commands
    if (trimmed.startsWith('git commit')) return '📝 Commit changes to git';
    if (trimmed.startsWith('git push')) return '🚀 Push commits to remote';
    if (trimmed.startsWith('git pull')) return '⬇️ Pull changes from remote';
    if (trimmed.startsWith('git status')) return '📋 Check git status';
    if (trimmed.startsWith('git add')) return '➕ Stage files for commit';

    // NPM commands
    if (trimmed.startsWith('npm install') || trimmed.startsWith('npm i')) return '📦 Install dependencies';
    if (trimmed.startsWith('npm run dev') || trimmed.startsWith('npm start')) return '🚀 Start development server';
    if (trimmed.startsWith('npm run build')) return '🔨 Build for production';
    if (trimmed.startsWith('npm test')) return '🧪 Run tests';

    // Yarn commands
    if (trimmed.startsWith('yarn add') || trimmed.startsWith('yarn install')) return '📦 Install dependencies';
    if (trimmed.startsWith('yarn dev') || trimmed.startsWith('yarn start')) return '🚀 Start development server';

    // Default
    return `⚡ ${command}`;
}

/**
 * Wrap a command execution with safety checks
 * Returns error if command is dangerous
 */
export async function safeExecuteCommand(
    command: string,
    executor: (cmd: string) => Promise<{ stdout: string; stderr: string }>
): Promise<{ success: boolean; output?: string; error?: string }> {
    const safety = checkCommandSafety(command);

    if (!safety.isSafe) {
        return {
            success: false,
            error: `${safety.reason}\n\n${safety.suggestion}`,
        };
    }

    try {
        const result = await executor(command);
        return {
            success: true,
            output: result.stdout || result.stderr,
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Command failed',
        };
    }
}
