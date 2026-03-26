/**
 * Hardware profile + Ollama model recommendations (catalog + tier + agent-tooling allowlist).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { ipcMain } from "electron";
import log from "electron-log";

const logger = log.scope("system-hardware");
const execFileAsync = promisify(execFile);

export type HardwareTier = "low" | "medium" | "high" | "ultra";

export interface HardwareProfile {
  totalMemBytes: number;
  cpuCount: number;
  platform: string;
  arch: string;
  cpuModel: string;
  gpuVramMb?: number;
  tier: HardwareTier;
}

const AGENT_PREFIXES = [
  /^llama3\.1/i,
  /^llama3\.2/i,
  /^llama3[^.]/i,
  /^mistral/i,
  /^mixtral/i,
  /^qwen2\.5/i,
  /^qwen2[^.]/i,
  /^command-r/i,
  /^phi3/i,
  /^gemma2/i,
  /^codellama/i,
];

function baseModelId(modelName: string): string {
  return (modelName.split(":")[0] ?? modelName).trim();
}

function supportsAtlarixAgents(modelName: string): boolean {
  const b = baseModelId(modelName);
  return AGENT_PREFIXES.some((re) => re.test(b));
}

function sizeClass(modelName: string): "small" | "medium" | "large" | "xlarge" {
  const m = modelName.toLowerCase();
  if (/\b(70|72|90|65)b\b/.test(m)) return "xlarge";
  if (/\b(32|34)b\b/.test(m)) return "large";
  if (/\b(13|14|14\.8)b\b/.test(m)) return "medium";
  return "small";
}

function computeTier(memBytes: number, gpuVramMb?: number): HardwareTier {
  const memGb = memBytes / 1024 ** 3;
  const vram = gpuVramMb ?? 0;
  const score = memGb + (vram / 1024) * 1.5;
  if (score >= 48) return "ultra";
  if (score >= 24) return "high";
  if (score >= 12) return "medium";
  return "low";
}

function modelFitsTier(modelName: string, tier: HardwareTier): boolean {
  const sz = sizeClass(modelName);
  const allowed: Record<HardwareTier, Array<typeof sz>> = {
    low: ["small"],
    medium: ["small", "medium"],
    high: ["small", "medium", "large"],
    ultra: ["small", "medium", "large", "xlarge"],
  };
  return allowed[tier].includes(sz);
}

async function detectGpuVramMb(): Promise<number | undefined> {
  const platform = process.platform;
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("system_profiler", ["SPDisplaysDataType"]);
      const m =
        stdout.match(/VRAM\s*\(Total\)\s*:\s*(\d+)\s*MB/i) ||
        stdout.match(/(\d+)\s*MB\s*VRAM/i);
      if (m) return parseInt(m[1], 10);
    } catch {
      /* no discrete GPU or profiler failed */
    }
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const line = stdout.trim().split("\n")[0];
    const mb = parseInt(line, 10);
    if (!Number.isNaN(mb)) return mb;
  } catch {
    /* no NVIDIA or driver */
  }
  return undefined;
}

export async function getHardwareProfile(): Promise<HardwareProfile> {
  const gpuVramMb = await detectGpuVramMb();
  const cpus = os.cpus();
  const totalMemBytes = os.totalmem();
  const tier = computeTier(totalMemBytes, gpuVramMb);
  return {
    totalMemBytes,
    cpuCount: cpus.length,
    platform: process.platform,
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? "unknown",
    gpuVramMb,
    tier,
  };
}

export interface OllamaRecommendationRow {
  name: string;
  supportsAgents: boolean;
  sizeClass: string;
  why: string;
}

export async function getOllamaRecommendations(): Promise<{
  profile: HardwareProfile;
  recommendations: OllamaRecommendationRow[];
}> {
  const profile = await getHardwareProfile();
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 18_000);
  let res: Response;
  try {
    res = await fetch("https://ollama.com/api/tags", { signal: ac.signal });
  } finally {
    clearTimeout(to);
  }
  if (!res.ok) {
    throw new Error(`Ollama library returned ${res.status}`);
  }
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  const names = (data.models ?? []).map((m) => m.name).filter(Boolean);

  const candidates = names.filter(
    (n) => supportsAtlarixAgents(n) && modelFitsTier(n, profile.tier),
  );

  const recommendations: OllamaRecommendationRow[] = candidates.slice(0, 6).map((name) => {
    const sc = sizeClass(name);
    return {
      name,
      supportsAgents: true,
      sizeClass: sc,
      why: `${sc} model; fits ${profile.tier} tier on this machine (RAM/VRAM heuristic). Known families for tool use in Atlarix: Llama 3.x, Mistral/Mixtral, Qwen2.5, Command R, Phi/Gemma variants.`,
    };
  });

  logger.info(
    `Ollama recommendations: tier=${profile.tier} count=${recommendations.length} (catalog ${names.length})`,
  );

  return { profile, recommendations };
}

export function registerSystemHardwareHandlers(): void {
  ipcMain.handle("system:get-hardware-profile", async () => getHardwareProfile());

  ipcMain.handle("ollama:get-recommendations", async () => getOllamaRecommendations());

  ipcMain.handle(
    "ollama:pull-model",
    async (
      _event,
      model: unknown,
    ): Promise<{ success: true } | { success: false; error: string }> => {
      if (typeof model !== "string" || !model.trim()) {
        return { success: false, error: "Model name required." };
      }
      const name = model.trim();
      try {
        await execFileAsync("ollama", ["pull", name], {
          env: process.env,
          maxBuffer: 20 * 1024 * 1024,
        });
        return { success: true };
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException & {
          stderr?: Buffer | string;
          stdout?: Buffer | string;
        };
        if (err.code === "ENOENT") {
          return {
            success: false,
            error:
              "Ollama CLI not found. Install Ollama from https://ollama.com and ensure `ollama` is on your PATH, then restart Atlarix.",
          };
        }
        const stderr =
          typeof err.stderr === "string"
            ? err.stderr
            : err.stderr?.toString?.() ?? "";
        const stdout =
          typeof err.stdout === "string"
            ? err.stdout
            : err.stdout?.toString?.() ?? "";
        const combined = `${stderr} ${stdout} ${err.message ?? ""}`.toLowerCase();
        if (
          combined.includes("file does not exist") ||
          combined.includes("manifest") ||
          combined.includes("not found")
        ) {
          return {
            success: false,
            error: `Model "${name}" was not found in the Ollama library. Check the name on ollama.com/library or run \`ollama pull ${name}\` in a terminal for details.`,
          };
        }
        if (
          combined.includes("connection refused") ||
          combined.includes("econnrefused") ||
          combined.includes("fetch failed")
        ) {
          return {
            success: false,
            error:
              "Could not reach Ollama. Start the Ollama app or daemon (default http://127.0.0.1:11434).",
          };
        }
        return {
          success: false,
          error: err.message || String(e),
        };
      }
    },
  );
}
