/**
 * Hardware profile + Ollama model recommendations (llm-checker primary, heuristic + catalog fallback).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { ipcMain } from "electron";
import log from "electron-log";
import { isLlmCheckerAvailable, runLlmChecker } from "@/ipc/utils/llm_checker_exec";

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
  /** e.g. Metal, Cuda, Rocm, Cpu — from llm-checker hw-detect when available */
  computeBackend?: string;
  /** Raw tier string from llm-checker (e.g. MEDIUM HIGH) for display */
  hwTierLabel?: string;
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

function mapLlmCheckerHardwareTierLabel(raw: string | undefined): HardwareTier {
  if (!raw) return "medium";
  const n = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (n.includes("ultra") || n.includes("extreme")) return "ultra";
  if (n.includes("very_high")) return "high";
  if (n.includes("medium") && n.includes("high")) return "high";
  if (n.includes("high")) return "high";
  if (n.includes("medium")) return "medium";
  if (n.includes("low")) return "low";
  return "medium";
}

function titleCaseBackend(s: string): string {
  const t = s.trim().toLowerCase();
  if (!t) return "CPU";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function parseHwDetectJson(stdout: string): Partial<HardwareProfile> | null {
  let j: unknown;
  try {
    j = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const root = j as {
    summary?: {
      hardwareTier?: string;
      systemRAM?: number;
      totalVRAM?: number;
      cpuModel?: string;
      bestBackend?: string;
    };
    cpu?: {
      brand?: string;
      cores?: { logical?: number; physical?: number };
      architecture?: string;
    };
  };
  const s = root.summary;
  if (!s) return null;
  const sysRamGb = Number(s.systemRAM);
  if (!Number.isFinite(sysRamGb) || sysRamGb <= 0) return null;
  const totalMemBytes = Math.round(sysRamGb * 1024 ** 3);
  const logical = root.cpu?.cores?.logical ?? root.cpu?.cores?.physical ?? os.cpus().length;
  const cpuModel = (s.cpuModel || root.cpu?.brand || os.cpus()[0]?.model || "unknown").trim();
  const totalVRAMgb = Number(s.totalVRAM);
  const gpuVramMb =
    Number.isFinite(totalVRAMgb) && totalVRAMgb > 0 ? Math.round(totalVRAMgb * 1024) : undefined;
  const tier = mapLlmCheckerHardwareTierLabel(s.hardwareTier);
  const computeBackend = titleCaseBackend(s.bestBackend || "cpu");
  return {
    totalMemBytes,
    cpuCount: logical,
    platform: process.platform,
    arch: root.cpu?.architecture || os.arch(),
    cpuModel,
    gpuVramMb,
    tier,
    computeBackend,
    hwTierLabel: s.hardwareTier,
  };
}

async function getHardwareProfileHeuristic(): Promise<HardwareProfile> {
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

export async function getHardwareProfile(): Promise<HardwareProfile> {
  if (!(await isLlmCheckerAvailable())) {
    return getHardwareProfileHeuristic();
  }
  try {
    const stdout = await runLlmChecker(["hw-detect", "--json"], { timeoutMs: 20_000 });
    const parsed = parseHwDetectJson(stdout);
    if (parsed?.totalMemBytes && parsed.cpuCount && parsed.tier) {
      return {
        totalMemBytes: parsed.totalMemBytes,
        cpuCount: parsed.cpuCount,
        platform: parsed.platform ?? process.platform,
        arch: parsed.arch ?? os.arch(),
        cpuModel: parsed.cpuModel ?? "unknown",
        gpuVramMb: parsed.gpuVramMb,
        tier: parsed.tier,
        computeBackend: parsed.computeBackend,
        hwTierLabel: parsed.hwTierLabel,
      };
    }
  } catch (e) {
    logger.warn("llm-checker hw-detect failed, using heuristic hardware profile:", e);
  }
  return getHardwareProfileHeuristic();
}

/** Single aggregate or 4D when upstream exposes all dimensions */
export type OllamaScoreDimensions = {
  quality?: number;
  speed?: number;
  fit?: number;
  context?: number;
  /** Overall / aggregate score (0–100) when 4D not available */
  overall?: number;
};

export interface OllamaRecommendationRow {
  name: string;
  supportsAgents: boolean;
  sizeClass: string;
  why: string;
  installed?: boolean;
  pullCommand?: string;
  tierLabel?: string;
  scores?: OllamaScoreDimensions;
}

export type OllamaRecommendationsSource = "llm-checker" | "heuristic";

export async function getOllamaRecommendations(): Promise<{
  profile: HardwareProfile;
  recommendations: OllamaRecommendationRow[];
  source: OllamaRecommendationsSource;
}> {
  const profile = await getHardwareProfile();

  if (!(await isLlmCheckerAvailable())) {
    return {
      profile,
      recommendations: await getHeuristicOllamaRecommendations(profile),
      source: "heuristic",
    };
  }

  try {
    const installedStdout = await runLlmChecker(["installed", "--json"], { timeoutMs: 25_000 });
    const arrStart = installedStdout.indexOf("[");
    const installedModels = (
      arrStart >= 0 ? JSON.parse(installedStdout.slice(arrStart)) : []
    ) as Array<{
      name: string;
      score?: number;
      useCase?: string;
      quantization?: string;
      quality?: number;
      speed?: number;
      fit?: number;
      context?: number;
    }>;

    const recommendStdout = await runLlmChecker(
      ["recommend", "--category", "coding", "--no-verbose"],
      { timeoutMs: 30_000 },
    );
    const codingBlock = extractCodingRecommendBlock(recommendStdout);
    const codingParsed = codingBlock ? parseCodingRecommendBlock(codingBlock) : [];

    const installedNames = new Set(installedModels.map((m) => m.name).filter(Boolean));
    const rows: OllamaRecommendationRow[] = [];

    for (const inst of installedModels.slice(0, 6)) {
      if (!inst.name) continue;
      const scores = extractScoresFromInstalled(inst);
      rows.push({
        name: inst.name,
        supportsAgents: supportsAtlarixAgents(inst.name),
        sizeClass: sizeClass(inst.name),
        why: [
          "Installed — ranked by llm-checker.",
          inst.useCase && `Use case: ${inst.useCase}.`,
          inst.quantization && `Quantization: ${inst.quantization}.`,
        ]
          .filter(Boolean)
          .join(" "),
        installed: true,
        scores: Object.keys(scores).length ? scores : inst.score != null ? { overall: inst.score } : undefined,
      });
    }

    for (const c of codingParsed) {
      if (!c.name || installedNames.has(c.name)) continue;
      rows.push({
        name: c.name,
        supportsAgents: supportsAtlarixAgents(c.name),
        sizeClass: sizeClass(c.name),
        why: [
          "Coding recommendation (llm-checker).",
          c.score != null && `Score ${c.score}/100.`,
          c.sizeLabel && `Size: ${c.sizeLabel}.`,
        ]
          .filter(Boolean)
          .join(" "),
        installed: false,
        pullCommand: c.pullCommand,
        scores: c.score != null ? { overall: c.score } : undefined,
      });
    }

    if (rows.length === 0) {
      return {
        profile,
        recommendations: await getHeuristicOllamaRecommendations(profile),
        source: "heuristic",
      };
    }

    logger.info(
      `Ollama recommendations (llm-checker): tier=${profile.tier} rows=${rows.length} installed=${installedModels.length}`,
    );

    return { profile, recommendations: rows.slice(0, 12), source: "llm-checker" };
  } catch (e) {
    logger.warn("llm-checker recommendations path failed, using heuristic fallback:", e);
    return {
      profile,
      recommendations: await getHeuristicOllamaRecommendations(profile),
      source: "heuristic",
    };
  }
}

function extractScoresFromInstalled(inst: {
  score?: number;
  quality?: number;
  speed?: number;
  fit?: number;
  context?: number;
}): OllamaScoreDimensions {
  const out: OllamaScoreDimensions = {};
  if (inst.quality != null) out.quality = inst.quality;
  if (inst.speed != null) out.speed = inst.speed;
  if (inst.fit != null) out.fit = inst.fit;
  if (inst.context != null) out.context = inst.context;
  if (
    out.quality != null &&
    out.speed != null &&
    out.fit != null &&
    out.context != null
  ) {
    return out;
  }
  if (inst.score != null) out.overall = inst.score;
  return out;
}

function extractCodingRecommendBlock(stdout: string): string | null {
  const re = /│\s*Coding\s*\([^)]*\):\s*\n/;
  const marker = re.exec(stdout);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  const rest = stdout.slice(start);
  const nextIdx = rest.search(
    /\n│\s*(?:Reasoning|Multimodal|Creative|Talking|Reading|General)\s*\(/,
  );
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

type ParsedCoding = { name: string; score?: number; pullCommand?: string; sizeLabel?: string };

function parseCodingRecommendBlock(block: string): ParsedCoding[] {
  const results: ParsedCoding[] = [];
  let cur: ParsedCoding | null = null;
  for (const line of block.split("\n")) {
    const modelM = line.match(/│\s+([\w.-]+:[\w.-]+)\s*\(([^)]*)\)/);
    if (modelM) {
      if (cur) results.push(cur);
      cur = { name: modelM[1], sizeLabel: modelM[2]?.trim() };
    }
    if (cur) {
      const scoreM = line.match(/Score:\s*(\d+)/);
      if (scoreM) cur.score = parseInt(scoreM[1], 10);
      const cmdM = line.match(/Command:\s*(ollama\s+pull\s+\S+)/);
      if (cmdM) cur.pullCommand = cmdM[1].trim();
    }
  }
  if (cur) results.push(cur);
  return results;
}

async function getHeuristicOllamaRecommendations(
  profile: HardwareProfile,
): Promise<OllamaRecommendationRow[]> {
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

  return candidates.slice(0, 6).map((name) => {
    const sc = sizeClass(name);
    return {
      name,
      supportsAgents: true,
      sizeClass: sc,
      why: `${sc} model; fits ${profile.tier} tier on this machine (RAM/VRAM heuristic). Known families for tool use in Atlarix: Llama 3.x, Mistral/Mixtral, Qwen2.5, Command R, Phi/Gemma variants.`,
    };
  });
}

export function registerSystemHardwareHandlers(): void {
  ipcMain.handle("system:get-hardware-profile", async () => getHardwareProfile());

  ipcMain.handle("ollama:get-recommendations", async () => getOllamaRecommendations());

  ipcMain.handle("ollama:llm-checker-available", async () => isLlmCheckerAvailable());

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

  ipcMain.handle(
    "ollama:remove-model",
    async (
      _event,
      model: unknown,
    ): Promise<{ success: true } | { success: false; error: string }> => {
      if (typeof model !== "string" || !model.trim()) {
        return { success: false, error: "Model name required." };
      }
      const name = model.trim();
      try {
        await execFileAsync("ollama", ["rm", name], {
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
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
