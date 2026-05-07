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
import { BrowserWindow } from 'electron';

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
    watcherProcess?: ChildProcess; // Background type checker (tsc --watch, etc)
    url: string | null;      // Raw dev server URL
    proxyUrl: string | null; // Error capture proxy URL (used for iframe)
    framework: string;
    startedAt: Date;
    outputBuffer: string;    // Accumulated output for the session
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
        onUrlDetected?: (url: string) => void,
        enableTypeCheck: boolean = true // New parameter for type checking
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

        // Start Type Watcher (LSP-Lite) if enabled
        let watcherProcess: ChildProcess | undefined;
        if (enableTypeCheck) {
            watcherProcess = this.startTypeWatcher(workspacePath, config.framework, (output) => {
                const srv = this.runningServers.get(workspaceId);
                if (srv) srv.outputBuffer += output;
                // Forward watcher output to the main output stream
                const mainWindow = BrowserWindow.getAllWindows()[0];
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('dev-server:output', {
                        workspaceId,
                        framework: config.framework,
                        output: output,
                        fullOutput: this.runningServers.get(workspaceId)?.outputBuffer + output, // Append to main buffer
                        status: 'running',
                        timestamp: Date.now(),
                        isWatcher: true,
                    });
                }
            });
        }

        // Track the server
        const server: RunningServer = {
            workspaceId,
            workspacePath,
            process: proc,
            watcherProcess, // Store the watcher process
            url: null,
            proxyUrl: null,  // Will be set when URL is detected
            framework: config.framework,
            startedAt: new Date(),
            outputBuffer: '',  // Initialize empty output buffer
        };
        this.runningServers.set(workspaceId, server);

        if (onUrlDetected) {
            this.urlCallbacks.set(workspaceId, onUrlDetected);
        }

        // Parse output for URL and emit to frontend
        const handleOutput = (data: Buffer) => {
            const output = data.toString();
            logger.log(`[${config.framework}] ${output.trim()}`);

            // Accumulate output
            server.outputBuffer += output;

            // Emit to frontend via IPC
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('dev-server:output', {
                    workspaceId,
                    framework: config.framework,
                    output: output,
                    fullOutput: server.outputBuffer,
                    status: 'running',
                    timestamp: Date.now(),
                });
            }

            // Try to extract URL
            const match = config.portPattern.exec(output);
            if (match && !server.url) {
                const detectedUrl = `http://localhost:${match[1]}`;
                server.url = detectedUrl;
                logger.log(`✅ Dev server ready at ${detectedUrl}`);

                // Notify callback with direct URL
                // Browser errors are now captured via Electron's CDP debugger (console_debugger.ts)
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

        // Return current status - prefer proxy URL if available
        const finalServer = this.runningServers.get(workspaceId);
        const finalUrl = finalServer?.proxyUrl || finalServer?.url || `http://localhost:${port}`;
        return {
            success: true,
            url: finalUrl,
        };
    }

    /**
     * Starts a type-checking watcher process (e.g., tsc --watch)
     */
    private startTypeWatcher(projectPath: string, framework: string, onOutput: (output: string) => void): ChildProcess | undefined {
        // Only support TypeScript projects for now
        const tsConfigPath = path.join(projectPath, 'tsconfig.json');
        if (!fs.existsSync(tsConfigPath)) {
            logger.log(`No tsconfig.json found in ${projectPath}. Skipping type watcher.`);
            return undefined;
        }

        logger.log(`Starting TypeScript watcher for ${projectPath}`);
        const watcher = spawn('npx', ['tsc', '--watch', '--noEmit', '--skipLibCheck'], {
            cwd: projectPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
            env: {
                ...process.env,
                FORCE_COLOR: '1', // Enable colored output
            },
        });

        watcher.stdout?.on('data', (data) => {
            const output = data.toString();
            logger.log(`[${framework} Watcher] ${output.trim()}`);
            onOutput(output);
        });

        watcher.stderr?.on('data', (data) => {
            const output = data.toString();
            logger.error(`[${framework} Watcher Error] ${output.trim()}`);
            onOutput(output);
        });

        watcher.on('error', (error) => {
            logger.error(`Type watcher process error for ${projectPath}:`, error);
        });

        watcher.on('exit', (code) => {
            logger.log(`Type watcher process exited for ${projectPath} with code ${code}`);
        });

        return watcher;
    }

    /**
     * Stop a dev server for a workspace
     */
    /** Last lines of combined dev server + watcher output for self-correction (workspaceId === app id). */
    getRecentOutputLines(workspaceId: number, maxLines = 200): string[] {
        const buf = this.runningServers.get(workspaceId)?.outputBuffer ?? "";
        if (!buf.trim()) return [];
        const lines = buf.split(/\r?\n/);
        return lines.slice(-maxLines);
    }

    clearOutputBuffer(workspaceId: number): void {
        const server = this.runningServers.get(workspaceId);
        if (server) server.outputBuffer = "";
    }

    stopServer(workspaceId: number): void {
        const server = this.runningServers.get(workspaceId);
        if (server) {
            logger.log(`Stopping dev server for workspace ${workspaceId}`);
            if (server.watcherProcess) {
                try {
                    logger.log(`Stopping watcher process for workspace ${workspaceId}`);
                    server.watcherProcess.kill();
                } catch (e) {
                    logger.error(`Error killing watcher process for workspace ${workspaceId}:`, e);
                }
            }

            // Stop main process
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
     * Get the URL for a running server (prefers proxy URL for error capture)
     */
    getServerUrl(workspaceId: number): string | null {
        const server = this.runningServers.get(workspaceId);
        // Prefer proxy URL for error capture, fall back to raw URL
        return server?.proxyUrl || server?.url || null;
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
            // Prefer proxy URL for error capture
            url: s.proxyUrl || s.url,
            framework: s.framework,
        }));
    }
}

// Export singleton
export const devServerManager = DevServerManager.getInstance();
