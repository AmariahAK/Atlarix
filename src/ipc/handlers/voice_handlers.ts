/**
 * BYOK cloud transcription (optional accuracy upgrade over on-device Whisper).
 *
 * The renderer records audio and, when the user picks a cloud transcription
 * provider, sends it here as base64. Main resolves the user's own key and calls
 * the provider's speech-to-text endpoint. This never touches Atlarix Core quota
 * — it's the user's key, their bill. Local Whisper stays the free default.
 */

import { ipcMain } from "electron";
import { getProviderApiKey } from "../shared/provider_api_keys";
import log from "electron-log";

const logger = log.scope("voice");

type CloudProvider = "openai" | "groq" | "gemini";

interface TranscribeParams {
  provider: CloudProvider;
  mimeType: string;
  dataBase64: string;
  language?: string;
}

type TranscribeResult = { ok: true; text: string } | { ok: false; error: string };

/** OpenAI + Groq share the OpenAI `/audio/transcriptions` multipart contract. */
async function transcribeOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  audio: Blob,
  language?: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, "audio.webm");
  form.append("model", model);
  if (language) form.append("language", language);
  form.append("response_format", "json");
  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

async function transcribeGemini(
  apiKey: string,
  audio: { mimeType: string; dataBase64: string },
): Promise<string> {
  const model = "gemini-2.0-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Transcribe this audio verbatim. Output only the transcript text." },
              { inline_data: { mime_type: audio.mimeType, data: audio.dataBase64 } },
            ],
          },
        ],
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (json.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
}

export function registerVoiceHandlers() {
  ipcMain.handle("voice:log", (_e, message: unknown) => {
    logger.info(`[diag] ${String(message)}`);
  });

  ipcMain.handle(
    "voice:transcribe-cloud",
    async (_e, params: TranscribeParams): Promise<TranscribeResult> => {
      try {
        const { provider, mimeType, dataBase64, language } = params;
        const providerKeyId =
          provider === "gemini" ? "google" : provider;
        const apiKey =
          (await getProviderApiKey(providerKeyId)) ??
          (provider === "gemini" ? await getProviderApiKey("gemini") : undefined);
        if (!apiKey) {
          return {
            ok: false,
            error: `No API key set for ${provider}. Add one in Settings → Providers, or use local transcription.`,
          };
        }

        if (provider === "gemini") {
          const text = await transcribeGemini(apiKey, { mimeType, dataBase64 });
          return { ok: true, text };
        }

        const bytes = Buffer.from(dataBase64, "base64");
        const audio = new Blob([bytes], { type: mimeType || "audio/webm" });
        const { baseUrl, model } =
          provider === "groq"
            ? {
                baseUrl: "https://api.groq.com/openai/v1",
                model: "whisper-large-v3-turbo",
              }
            : { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-transcribe" };
        const text = await transcribeOpenAiCompatible(
          baseUrl,
          apiKey,
          model,
          audio,
          language,
        );
        return { ok: true, text };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        logger.warn(`cloud transcription failed: ${error}`);
        return { ok: false, error };
      }
    },
  );
}
