/**
 * view_image — let the model LOOK at an image file.
 *
 * Images used to reach the model only as attachments the user added, so an
 * agent that made a screenshot, rendered a chart or pulled frames out of a video
 * with ffmpeg could produce the file but never see it. This returns the image in
 * the one shape the turn already knows how to send to a vision model:
 * `{ success, mimeType: "image/*", data }` at the top level of the result
 * (`extractImageMedia` in lib/ai/tool-model-output.ts). Matching that shape is
 * what earns the truncation exemption, the base64 redaction in the transcript,
 * the image part for the model — and, on Atlarix Auto, the proxy lifting it out
 * of the tool message and climbing to a model that can see it.
 *
 * Video is not a separate tool on purpose: the model extracts frames with the
 * shell (`ffmpeg -i in.mp4 -vf fps=1 frame_%03d.png`) and views those. Audio
 * goes through `transcribe_audio`.
 *
 * Paths follow read_file: workspace-relative, or absolute (reads are allowed
 * anywhere; the workspace is the default scope, not a wall), with the same
 * secret-path and symlink-escape checks for workspace paths.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ToolRegistry, createParameters, stringParam } from "./registry";
import {
  resolvePathUnderWorkspace,
  resolveToolTargetPath,
  stripToolPathPrefixes,
} from "../../ipc/utils/safeWorkspaceRelativePath";
import { assertReadablePath } from "@/lib/security/env-secret-paths";
import { assertRealpathContained } from "@/lib/security/realpath-contain";
import { detectImageMime } from "@/lib/file-content-type";

/** Wider than this is downscaled (when Electron's nativeImage is available). */
export const VIEW_IMAGE_MAX_WIDTH = 1280;
/** Same hard limit as the emulator screenshot: past this it is an outage, not a payload. */
export const VIEW_IMAGE_MAX_BYTES = 1_500_000;

/** Resolve a tool path the way read_file does, or throw a readable error. */
export function resolveMediaPath(
  rawPath: string,
  workspace: string | undefined,
): string {
  const raw = rawPath.trim();
  const explicit =
    path.isAbsolute(raw) || /^\.\.[\\/]/.test(raw) || raw === "..";
  if (explicit) {
    return resolveToolTargetPath(workspace || process.cwd(), raw).absPath;
  }
  if (!workspace) return path.resolve(stripToolPathPrefixes(raw));
  const full = resolvePathUnderWorkspace(workspace, raw);
  assertReadablePath(raw, workspace);
  assertRealpathContained(full, workspace, [], raw);
  return full;
}

/**
 * BMP's signature is only "BM", which plenty of text starts with. A real one
 * also carries a DIB header whose size is one of a handful of known values.
 */
function isRealBmp(buffer: Buffer): boolean {
  if (buffer.length < 18) return false;
  return [12, 40, 52, 56, 64, 108, 124].includes(buffer.readUInt32LE(14));
}

async function downscale(
  buffer: Buffer,
): Promise<{ data: Buffer; mimeType?: string }> {
  try {
    const { nativeImage } = await import("electron");
    if (typeof nativeImage?.createFromBuffer !== "function")
      return { data: buffer };
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return { data: buffer };
    const { width } = image.getSize();
    if (width <= VIEW_IMAGE_MAX_WIDTH) return { data: buffer };
    return {
      data: image.resize({ width: VIEW_IMAGE_MAX_WIDTH }).toJPEG(85),
      mimeType: "image/jpeg",
    };
  } catch {
    // The CLI and headless runs have no Electron: send what is on disk when it
    // is small enough, and say how to shrink it when it is not.
    return { data: buffer };
  }
}

ToolRegistry.register({
  name: "view_image",
  description:
    "Look at an image file (PNG, JPEG, GIF, WebP, BMP). For a video, extract frames first (for example `ffmpeg -i clip.mp4 -vf fps=1 frames/f_%03d.png`) and view the ones you need.",
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      path: stringParam(
        "Path to the image — workspace-relative, or an ABSOLUTE path for anything outside the workspace.",
      ),
    },
    ["path"],
  ),
  handler: async ({ path: rawPath, workspace }) => {
    const shown = String(rawPath ?? "").trim();
    if (!shown) return { success: false, error: "Give the image's path." };

    let fullPath: string;
    try {
      fullPath = resolveMediaPath(shown, workspace);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let buffer: Buffer;
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.isDirectory()) {
        return {
          success: false,
          error: `"${shown}" is a directory, not an image.`,
        };
      }
      buffer = await fs.promises.readFile(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return {
        success: false,
        error:
          code === "ENOENT"
            ? `No file at "${shown}".`
            : `Could not read "${shown}": ${String((err as Error)?.message ?? err)}`,
      };
    }

    const mime = detectImageMime(buffer.subarray(0, 64));
    if (!mime || (mime === "image/bmp" && !isRealBmp(buffer))) {
      return {
        success: false,
        error: `"${shown}" is not a PNG, JPEG, GIF, WebP or BMP image. For an SVG, read its source with read_file; for a video, extract frames with ffmpeg and view those.`,
      };
    }

    const scaled = await downscale(buffer);
    if (scaled.data.length > VIEW_IMAGE_MAX_BYTES) {
      return {
        success: false,
        error:
          `"${shown}" is ${Math.round(scaled.data.length / 1024)} KB, too large to send. ` +
          `Make a smaller copy first, for example \`ffmpeg -y -i "${shown}" -vf scale=${VIEW_IMAGE_MAX_WIDTH}:-1 /tmp/view.jpg\`, and view that.`,
      };
    }

    return {
      success: true,
      mimeType: scaled.mimeType ?? mime,
      data: scaled.data.toString("base64"),
      filename: shown,
      origin: "file" as const,
    };
  },
});

// ─── transcribe_audio ────────────────────────────────────────────────────────

/** OpenAI's upload limit for a transcription, and the proxy's. */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
};

/** Own-key providers that can transcribe, best first. */
const OWN_KEY_PREFERENCE = ["openai", "groq", "gemini"];

ToolRegistry.register({
  name: "transcribe_audio",
  description:
    "Transcribe an audio file (mp3, m4a, wav, ogg, webm, flac) to text. For a video's soundtrack, extract it first (for example `ffmpeg -i clip.mp4 -vn -ac 1 -b:a 64k audio.m4a`).",
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      path: stringParam(
        "Path to the audio file — workspace-relative, or an ABSOLUTE path for anything outside the workspace.",
      ),
      language: stringParam(
        "Optional ISO-639-1 language of the speech (e.g. en, sw), when known.",
      ),
    },
    ["path"],
  ),
  handler: async ({ path: rawPath, language, workspace, _chatSessionId }) => {
    const shown = String(rawPath ?? "").trim();
    if (!shown) return { success: false, error: "Give the audio file's path." };

    let fullPath: string;
    try {
      fullPath = resolveMediaPath(shown, workspace);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const mimeType = AUDIO_MIME_BY_EXT[path.extname(fullPath).toLowerCase()];
    if (!mimeType) {
      return {
        success: false,
        error: `"${shown}" is not an audio file this can read (mp3, m4a, wav, ogg, webm, flac). Convert it with ffmpeg first.`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return {
        success: false,
        error:
          code === "ENOENT"
            ? `No file at "${shown}".`
            : `Could not read "${shown}".`,
      };
    }
    if (bytes.length > TRANSCRIBE_MAX_BYTES) {
      return {
        success: false,
        error: `"${shown}" is ${Math.round(bytes.length / 1048576)} MB; the limit is 25 MB. Re-encode it smaller (for example \`ffmpeg -i "${shown}" -ac 1 -b:a 32k small.m4a\`) or split it, and transcribe the parts.`,
      };
    }
    const lang =
      typeof language === "string" && language.trim()
        ? language.trim()
        : undefined;

    // Paid Atlarix Core: our proxy, billed to the account.
    const { paidCoreForChat, coreProxyPost } = await import(
      "@/lib/core/paid-core"
    );
    if (await paidCoreForChat(_chatSessionId)) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: mimeType }),
        path.basename(fullPath),
      );
      if (lang) form.append("language", lang);
      const res = await coreProxyPost("/audio/transcriptions", { form }).catch(
        () => null,
      );
      if (res?.ok) {
        const json = (await res.json().catch(() => ({}))) as { text?: string };
        return {
          success: true,
          text: (json.text ?? "").trim(),
          source: "Atlarix",
        };
      }
      if (res && res.status === 402) {
        return {
          success: false,
          error:
            "Your Atlarix balance can't cover this transcription. Top up at atlarix.dev, or add your own OpenAI/Groq/Gemini key.",
        };
      }
      // Otherwise fall through to an own key, if there is one.
    }

    // Your own key.
    const { buildTranscriptionProviderOptions, transcribeWithOwnKey } =
      await import("@/ipc/handlers/voice_handlers");
    const { getConfiguredProviders } = await import(
      "@/ipc/shared/provider_api_keys"
    );
    const { getAudioInputModelIds } = await import("@/lib/models_dev");
    const options = await buildTranscriptionProviderOptions({
      configuredProviders: getConfiguredProviders,
      audioModelIds: getAudioInputModelIds,
    }).catch(() => []);
    const ids = options.map((o) => o.id);
    const provider = OWN_KEY_PREFERENCE.find((p) => ids.includes(p)) ?? ids[0];
    if (!provider) {
      return {
        success: false,
        error:
          "No transcription available: this needs paid Atlarix (Auto or a Core model) or your own OpenAI, Groq or Gemini key.",
      };
    }
    const r = await transcribeWithOwnKey({
      provider,
      mimeType,
      dataBase64: bytes.toString("base64"),
      language: lang,
    });
    return r.ok
      ? { success: true, text: r.text, source: provider }
      : { success: false, error: r.error };
  },
});
