/**
 * Dev Server Manager
 * ==================
 * Auto-detect and spawn frontend dev servers for live preview (Lovable-style)
 * 
 * Supports:
 * - Vite (npm run dev / vite)
 * - Next.js (npm run dev / next dev)
 * - Create React App (npm start / react-scripts start)
 * - Nuxt (npm run dev / nuxt dev)
 * - Astro (npm run dev / astro dev)
 */

import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

const execAsync = promisify(exec);
const logger = log.scope('dev-server-manager');

// ============================================
// TYPES
// ============================================

export interface DevServerConfig {
    framework: 'vite' | 'next' | 'cra' | 'nuxt' | 'astro' | 'unknown';
    command: string;
    args: string[];
    defaultPort: number;
    portPattern: RegExp;
}

export interface RunningServer {
    workspaceId: number;
    workspacePath: string;
    process: ChildProcess;
    url: string | null;
    framework: string;
    startedAt: Date;
}

// ============================================
// FRAMEWORK DETECTION
// ============================================

const FRAMEWORK_CONFIGS: Record<string, DevServerConfig> = {
    vite: {
        framework: 'vite',
        command: 'npm',
        args: ['run', 'dev'],
        defaultPort: 5173,
        portPattern: /Local:\s+http:\/\/localhost:(\d+)/,
    },
    next: {
        framework: 'next',
        command: 'npm',
        args: ['run', 'dev'],
        defaultPort: 3000,
        portPattern: /http:\/\/localhost:(\d+)/,
    },
    cra: {
        framework: 'cra',
        command: 'npm',
        args: ['start'],
        defaultPort: 3000,
        portPattern: /Local:\s+http:\/\/localhost:(\d+)/,
    },
    nuxt: {
        framework: 'nuxt',
        command: 'npm',
        args: ['run', 'dev'],
        defaultPort: 3000,
        portPattern: /Local:\s+http:\/\/localhost:(\d+)/,
    },
    astro: {
        framework: 'astro',
        command: 'npm',
        args: ['run', 'dev'],
        defaultPort: 4321,
        portPattern: /Local\s+http:\/\/localhost:(\d+)/,
    },
};

/**
 * Detect frontend framework from package.json
 */
export async function detectFramework(workspacePath: string): Promise<DevServerConfig | null> {
    const packageJsonPath = path.join(workspacePath, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
        logger.log(`No package.json found at ${workspacePath}`);
        return null;
    }

    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const deps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
        };
        const scripts = packageJson.scripts || {};

        // Check for frameworks in order of specificity
        if (deps['next']) {
            logger.log('Detected Next.js project');
            return FRAMEWORK_CONFIGS.next;
        }
        if (deps['vite']) {
            logger.log('Detected Vite project');
            return FRAMEWORK_CONFIGS.vite;
        }
        if (deps['nuxt']) {
            logger.log('Detected Nuxt project');
            return FRAMEWORK_CONFIGS.nuxt;
        }
        if (deps['astro']) {
            logger.log('Detected Astro project');
            return FRAMEWORK_CONFIGS.astro;
        }
        if (deps['react-scripts']) {
            logger.log('Detected Create React App project');
            return FRAMEWORK_CONFIGS.cra;
        }

        // Check if there's a dev script at all
        if (scripts['dev']) {
            logger.log('Found dev script, assuming Vite-like project');
            return FRAMEWORK_CONFIGS.vite;
        }
        if (scripts['start']) {
            logger.log('Found start script, assuming CRA-like project');
            return FRAMEWORK_CONFIGS.cra;
        }

        logger.log('No recognized frontend framework found');
        return null;
    } catch (error) {
        logger.error('Error reading package.json:', error);
        return null;
    }
}

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
    try {
        await execAsync(`lsof -i:${port}`);
        return false; // Port is in use
    } catch {
        return true; // Port is available
    }
}

/**
 * Find an available port starting from the default
 */
async function findAvailablePort(startPort: number): Promise<number> {
    let port = startPort;
    while (!(await isPortAvailable(port)) && port < startPort + 100) {
        port++;
    }
    return port;
}

// ============================================
// DEV SERVER MANAGER CLASS
// ============================================

export class DevServerManager {
    private static instance: DevServerManager;
    private runningServers: Map<number, RunningServer> = new Map();
    private urlCallbacks: Map<number, (url: string) => void> = new Map();

    private constructor() { }

    static getInstance(): DevServerManager {
        if (!DevServerManager.instance) {
            DevServerManager.instance = new DevServerManager();
        }
        return DevServerManager.instance;
    }

    /**
     * Start a dev server for a workspace
     */
    async startServer(
        workspaceId: number,
        workspacePath: string,
        onUrlDetected?: (url: string) => void
    ): Promise<{ success: boolean; url?: string; error?: string }> {
        // Check if already running
        const existing = this.runningServers.get(workspaceId);
        if (existing && existing.url) {
            logger.log(`Dev server already running for workspace ${workspaceId} at ${existing.url}`);
            return { success: true, url: existing.url };
        }

        // Detect framework
        const config = await detectFramework(workspacePath);
        if (!config) {
            return { success: false, error: 'Not a recognized frontend project' };
        }

        logger.log(`🚀 Starting ${config.framework} dev server for workspace ${workspaceId}`);

        // Find available port
        const port = await findAvailablePort(config.defaultPort);

        // Spawn the dev server process
        const proc = spawn(config.command, config.args, {
            cwd: workspacePath,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
            env: {
                ...process.env,
                PORT: port.toString(), // For CRA
                BROWSER: 'none', // Don't auto-open browser
                FORCE_COLOR: '1', // Enable colored output
            },
        });

        // Track the server
        const server: RunningServer = {
            workspaceId,
            workspacePath,
            process: proc,
            url: null,
            framework: config.framework,
            startedAt: new Date(),
        };
        this.runningServers.set(workspaceId, server);

        if (onUrlDetected) {
            this.urlCallbacks.set(workspaceId, onUrlDetected);
        }

        // Parse output for URL
        const handleOutput = (data: Buffer) => {
            const output = data.toString();
            logger.log(`[${config.framework}] ${output.trim()}`);

            // Try to extract URL
            const match = config.portPattern.exec(output);
            if (match) {
                const detectedUrl = `http://localhost:${match[1]}`;
                server.url = detectedUrl;
                logger.log(`✅ Dev server ready at ${detectedUrl}`);

                const callback = this.urlCallbacks.get(workspaceId);
                if (callback) {
                    callback(detectedUrl);
                }
            }
        };

        proc.stdout?.on('data', handleOutput);
        proc.stderr?.on('data', handleOutput);

        proc.on('error', (error) => {
            logger.error(`Dev server error for workspace ${workspaceId}:`, error);
        });

        proc.on('exit', (code) => {
            logger.log(`Dev server exited for workspace ${workspaceId} with code ${code}`);
            this.runningServers.delete(workspaceId);
            this.urlCallbacks.delete(workspaceId);
        });

        // Wait a bit for the server to start
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Return current status
        const finalServer = this.runningServers.get(workspaceId);
        return {
            success: true,
            url: finalServer?.url || `http://localhost:${port}`,
        };
    }

    /**
     * Stop a dev server for a workspace
     */
    stopServer(workspaceId: number): void {
        const server = this.runningServers.get(workspaceId);
        if (server) {
            logger.log(`Stopping dev server for workspace ${workspaceId}`);
            server.process.kill('SIGTERM');
            this.runningServers.delete(workspaceId);
            this.urlCallbacks.delete(workspaceId);
        }
    }

    /**
     * Stop all running dev servers
     */
    stopAllServers(): void {
        logger.log('Stopping all dev servers');
        for (const [id] of this.runningServers) {
            this.stopServer(id);
        }
    }

    /**
     * Get the URL for a running server
     */
    getServerUrl(workspaceId: number): string | null {
        return this.runningServers.get(workspaceId)?.url || null;
    }

    /**
     * Check if a workspace has a running server
     */
    isServerRunning(workspaceId: number): boolean {
        return this.runningServers.has(workspaceId);
    }

    /**
     * Get all running servers
     */
    getRunningServers(): Array<{ workspaceId: number; url: string | null; framework: string }> {
        return Array.from(this.runningServers.values()).map((s) => ({
            workspaceId: s.workspaceId,
            url: s.url,
            framework: s.framework,
        }));
    }
}

// Export singleton
export const devServerManager = DevServerManager.getInstance();
