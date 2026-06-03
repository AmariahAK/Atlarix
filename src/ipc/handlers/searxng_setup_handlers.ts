/**
 * SearxNG Auto-Setup Handlers
 * ============================
 * One-click setup for SearxNG via Docker
 * Embeds config - no external files needed
 */

import { ipcMain, app } from "electron";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";

const execAsync = promisify(exec);

interface SetupResult {
    success: boolean;
    message: string;
    url?: string;
}

// Embedded SearxNG config (no external file needed!)
const SEARXNG_CONFIG = `# Atlarix SearxNG Config - Auto-generated
use_default_settings: true

server:
  secret_key: "atlarix-searxng-secret"
  limiter: false
  image_proxy: true
  bind_address: "0.0.0.0:8080"
  method: "GET"

search:
  safe_search: 0
  autocomplete: "google"
  default_lang: "en"
  formats:
    - html
    - json

ui:
  static_use_hash: true
  default_theme: simple
  query_in_title: true

outgoing:
  request_timeout: 5.0
  max_request_timeout: 15.0

engines:
  - name: google
    disabled: false
  - name: bing
    disabled: false
  - name: duckduckgo
    disabled: false
  - name: github
    disabled: false
  - name: stackoverflow
    disabled: false
  - name: reddit
    disabled: false
  - name: wikipedia
    disabled: false
  - name: google scholar
    disabled: false
`;

/**
 * Check if Docker is installed and running
 */
async function checkDockerInstalled(): Promise<{ installed: boolean; running: boolean; error?: string }> {
    try {
        await execAsync("docker --version");

        // Check if Docker daemon is running
        try {
            await execAsync("docker info", { timeout: 5000 });
            return { installed: true, running: true };
        } catch {
            return { installed: true, running: false, error: "Docker is installed but not running. Please start Docker Desktop." };
        }
    } catch {
        return { installed: false, running: false, error: "Docker not found. Please install Docker Desktop." };
    }
}

/**
 * Check if SearxNG container is running
 */
async function checkSearxngRunning(): Promise<{ running: boolean; containerId?: string }> {
    try {
        const { stdout } = await execAsync('docker ps --filter "name=atlarix-searxng" --format "{{.ID}}"');
        const containerId = stdout.trim();
        return { running: !!containerId, containerId };
    } catch {
        return { running: false };
    }
}

/**
 * Stop and remove existing SearxNG container
 */
async function stopExistingSearxng(): Promise<void> {
    try {
        await execAsync("docker stop atlarix-searxng 2>/dev/null || true");
        await execAsync("docker rm atlarix-searxng 2>/dev/null || true");
    } catch {
        // Ignore errors if container doesn't exist
    }
}

/**
 * Setup SearxNG with Docker
 */
async function setupSearxng(progressCallback?: (message: string) => void): Promise<SetupResult> {
    const log = (msg: string) => {
        console.log(`[SearxNG Setup] ${msg}`);
        progressCallback?.(msg);
    };

    // 1. Check Docker
    log("Checking Docker...");
    const dockerStatus = await checkDockerInstalled();
    if (!dockerStatus.installed) {
        return {
            success: false,
            message: dockerStatus.error || "Docker not found. Please install Docker Desktop from https://docker.com",
        };
    }
    if (!dockerStatus.running) {
        return {
            success: false,
            message: dockerStatus.error || "Docker is not running. Please start Docker Desktop.",
        };
    }

    // 2. Create config directory in app data
    log("Creating configuration...");
    const configDir = path.join(app.getPath("userData"), "searxng");
    await fs.mkdir(configDir, { recursive: true });

    const configPath = path.join(configDir, "settings.yml");
    await fs.writeFile(configPath, SEARXNG_CONFIG, "utf-8");
    console.log(`[SearxNG Setup] Config written to: ${configPath}`);

    // 3. Stop existing container if any
    log("Cleaning up old containers...");
    await stopExistingSearxng();

    // 4. Pull latest image
    log("Downloading SearxNG (this may take a minute)...");
    try {
        await execAsync("docker pull searxng/searxng:latest", { timeout: 180000 }); // 3 min timeout
    } catch (error: any) {
        return {
            success: false,
            message: `Failed to download SearxNG: ${error.message}. Check your internet connection.`,
        };
    }

    // 5. Run container with mounted config
    log("Starting SearxNG...");
    try {
        const isWindows = process.platform === "win32";
        const mountPath = isWindows
            ? configPath.replace(/\\/g, "/")  // Windows: C:/Users/... 
            : configPath;

        const command = `docker run -d \
            -p 8080:8080 \
            --name atlarix-searxng \
            -v "${mountPath}:/etc/searxng/settings.yml:ro" \
            --restart unless-stopped \
            searxng/searxng:latest`;

        await execAsync(command);
    } catch (error: any) {
        // Check if port is in use
        if (error.message?.includes("port is already allocated")) {
            return {
                success: false,
                message: "Port 8080 is already in use. Stop the other service or use a different port.",
            };
        }
        return {
            success: false,
            message: `Failed to start SearxNG: ${error.message}`,
        };
    }

    // 6. Wait for container to be ready
    log("Waiting for SearxNG to start...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 7. Verify it's running and responding
    try {
        const response = await fetch("http://127.0.0.1:8080/search?q=test&format=json", {
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            log("Container started but health check failed. Waiting longer...");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    } catch {
        // Container might need more time, but it's probably running
        log("Health check timed out, but container is running");
    }

    // 8. Final check
    const status = await checkSearxngRunning();
    if (!status.running) {
        return {
            success: false,
            message: "Container started but stopped unexpectedly. Check Docker logs for details.",
        };
    }

    log("SearxNG is ready!");
    return {
        success: true,
        message: "SearxNG is now running!",
        url: "http://127.0.0.1:8080",
    };
}

/**
 * Stop SearxNG container
 */
async function stopSearxng(): Promise<SetupResult> {
    try {
        await stopExistingSearxng();
        return {
            success: true,
            message: "SearxNG stopped successfully",
        };
    } catch (error: any) {
        return {
            success: false,
            message: `Failed to stop SearxNG: ${error.message}`,
        };
    }
}

/**
 * Get SearxNG container logs
 */
async function getSearxngLogs(lines: number = 50): Promise<string> {
    try {
        const { stdout } = await execAsync(`docker logs --tail ${lines} atlarix-searxng 2>&1`);
        return stdout;
    } catch {
        return "No logs available";
    }
}

/**
 * Register IPC handlers
 */
export function registerSearxngSetupHandlers() {
    ipcMain.handle("searxng:check-docker", async () => {
        return await checkDockerInstalled();
    });

    ipcMain.handle("searxng:check-status", async () => {
        return await checkSearxngRunning();
    });

    ipcMain.handle("searxng:setup", async () => {
        return await setupSearxng();
    });

    ipcMain.handle("searxng:stop", async () => {
        return await stopSearxng();
    });

    ipcMain.handle("searxng:logs", async (_, lines?: number) => {
        return await getSearxngLogs(lines);
    });

    console.log("[SearxNG Setup] IPC handlers registered");
}

/**
 * Auto-start SearxNG on app launch (optional, call from main.ts)
 */
export async function autoStartSearxng(): Promise<void> {
    const dockerStatus = await checkDockerInstalled();
    if (!dockerStatus.running) {
        console.log("[SearxNG] Docker not available, skipping auto-start");
        return;
    }

    const status = await checkSearxngRunning();
    if (status.running) {
        console.log("[SearxNG] Already running");
        return;
    }

    console.log("[SearxNG] Auto-starting...");
    const result = await setupSearxng();
    if (result.success) {
        console.log(`[SearxNG] ✅ Ready at ${result.url}`);
    } else {
        console.log(`[SearxNG] ⚠️ Auto-start failed: ${result.message}`);
    }
}

/**
 * Auto-stop SearxNG when app quits
 * This prevents the Docker container from running after Atlarix closes
 */
export function registerSearxngAutoStop(): void {
    app.on("will-quit", async (_event) => {
        // Check if SearxNG is running
        const status = await checkSearxngRunning();
        if (status.running) {
            console.log("[SearxNG] App quitting, stopping Docker container...");
            try {
                await stopExistingSearxng();
                console.log("[SearxNG] Container stopped successfully");
            } catch (error) {
                console.log("[SearxNG] Failed to stop container:", error);
            }
        }
    });

    // Also handle before-quit for immediate cleanup
    app.on("before-quit", async () => {
        const status = await checkSearxngRunning();
        if (status.running) {
            console.log("[SearxNG] Before quit, ensuring container is stopped...");
            await stopExistingSearxng();
        }
    });

    console.log("[SearxNG] Auto-stop on quit registered");
}
