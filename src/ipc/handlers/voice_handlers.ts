/**
 * BYOK transcription.
 *
 * The renderer records audio and sends it here as base64. Main resolves the
 * user's own key and calls the provider's speech-to-text endpoint. This never
 * touches Atlarix Core quota — it's the user's key, their bill.
 *
 * THIS IS THE ONLY TRANSCRIPTION PATH. The on-device Whisper engine that used to
 * be the free default is deleted: it materialised ~285 MB of weights in the
 * RENDERER whenever a composer mounted, and took an 8 GB machine to
 * "your system has run out of application memory" twice. See `useVoiceInput.ts`
 * for the measurements.
 */

import { ipcMain } from "electron";
import { getProviderApiKey } from "../shared/provider_api_keys";
import { CLOUD_PROVIDERS } from "../shared/language_model_constants";
import log from "electron-log";

const logger = log.scope("voice");

/**
 * Any provider id may be sent. Google/Gemini needs its own wire format; every
 * other provider is assumed OpenAI-compatible (`POST {base}/audio/transcriptions`),
 * which is what the STT ecosystem has standardized on. Deliberately NOT a closed
 * union — the app ships 20 built-in providers plus the models.dev long tail, and
 * an allowlist here would silently exclude all of them.
 */
type CloudProvider = string;

interface TranscribeParams {
  provider: CloudProvider;
  mimeType: string;
  dataBase64: string;
  language?: string;
  /** Optional explicit model id; otherwise resolved from the live catalog. */
  model?: string;
}

/** Providers whose transcription wire format is Google's, not OpenAI's. */
const GOOGLE_PROVIDER_IDS = new Set(["gemini", "google"]);

/**
 * Last-resort STT model per provider, used only when the live catalog can't
 * name an audio-input model. These are floors, not the source of truth — the
 * catalog is consulted first so new models are picked up without a release.
 */
const FALLBACK_STT_MODEL: Record<string, string> = {
  openai: "gpt-4o-transcribe",
  groq: "whisper-large-v3-turbo",
};

/**
 * Resolve the transcription model from the models.dev catalog: the newest
 * audio-input model this provider exposes. Keeps voice off the same hardcoded-id
 * treadmill the model pickers were just taken off.
 */
async function resolveTranscriptionModel(
  provider: string,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit?.trim()) return explicit.trim();
  try {
    const { getAudioInputModelIds } = await import("@/lib/models_dev");
    const ids = await getAudioInputModelIds(provider);
    if (ids.length > 0) return ids[0];
  } catch {
    // Catalog unavailable — fall through to the floor below.
  }
  return FALLBACK_STT_MODEL[provider];
}

/** Base URL for an OpenAI-compatible provider, from the live catalog. */
async function resolveTranscriptionBaseUrl(
  provider: string,
): Promise<string | undefined> {
  try {
    const { getProviderApiBaseUrl } = await import("@/lib/models_dev");
    const url = await getProviderApiBaseUrl(provider);
    if (url) return url.replace(/\/$/, "");
  } catch {
    // Fall through.
  }
  return undefined;
}

type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * OpenAI rejects an upload whose FILENAME has no recognised audio extension,
 * regardless of the part's content type — so the name has to follow the
 * container the renderer actually recorded, which is ogg where the platform
 * offers it and webm otherwise.
 */
const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

export function audioFilename(mimeType: string): string {
  const bare = (mimeType.split(";")[0] || "").trim().toLowerCase();
  return `audio.${EXTENSION_BY_MEDIA_TYPE[bare] ?? "webm"}`;
}

/** OpenAI + Groq share the OpenAI `/audio/transcriptions` multipart contract. */
async function transcribeOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  audio: Blob,
  language?: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, audioFilename(audio.type));
  form.append("model", model);
  if (language) form.append("language", language);
  form.append("response_format", "json");
  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `${res.status} ${await res.text().catch(() => res.statusText)}`,
    );
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

async function transcribeGemini(
  apiKey: string,
  audio: { mimeType: string; dataBase64: string },
  model: string,
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      // Key in the header, not the query string — query params land in logs and
      // proxy traces. Matches the Google model fetcher.
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "Transcribe this audio verbatim. Output only the transcript text.",
              },
              {
                inline_data: {
                  mime_type: audio.mimeType,
                  data: audio.dataBase64,
                },
              },
            ],
          },
        ],
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `${res.status} ${await res.text().catch(() => res.statusText)}`,
    );
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (json.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
}

export type TranscriptionProviderOption = { id: string; label: string };

/**
 * Build the composer's transcription list: providers the user has a key for
 * AND that expose an audio-input model, labelled from the cloud catalog.
 *
 * MAY BE EMPTY, and that is a meaningful answer rather than a failure. It used
 * to be seeded with an always-present on-device entry, so "no options" was
 * unrepresentable; now an empty list is how the composer learns there is no BYOK
 * transcription, and it falls back to the active model's own audio input (or
 * hides the mic entirely).
 *
 * Exported for tests — the IPC wrapper below is a thin shell around it.
 */
export async function buildTranscriptionProviderOptions(deps: {
  configuredProviders: () => Promise<string[]>;
  audioModelIds: (providerId: string) => Promise<string[]>;
}): Promise<TranscriptionProviderOption[]> {
  const configured = await deps.configuredProviders();
  const seen = new Set<string>();
  const out: TranscriptionProviderOption[] = [];

  for (const id of configured) {
    // gemini/google are one provider with one key — collapse so the menu
    // can't offer the same thing twice under two names.
    const canonical = GOOGLE_PROVIDER_IDS.has(id) ? "gemini" : id;
    if (seen.has(canonical)) continue;

    const models = await deps.audioModelIds(canonical);
    // A fallback entry means we can still transcribe even if the catalog has
    // no audio row for it (e.g. an OpenAI-compatible endpoint the catalog
    // describes only for chat).
    if (models.length === 0 && !FALLBACK_STT_MODEL[canonical]) continue;

    seen.add(canonical);
    out.push({
      id: canonical,
      label: `${CLOUD_PROVIDERS[canonical]?.displayName ?? canonical} (BYOK)`,
    });
  }

  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

export function registerVoiceHandlers() {
  ipcMain.handle(
    "voice:list-transcription-providers",
    async (): Promise<TranscriptionProviderOption[]> => {
      try {
        const { getConfiguredProviders } = await import(
          "../shared/provider_api_keys"
        );
        const { getAudioInputModelIds } = await import("@/lib/models_dev");
        return await buildTranscriptionProviderOptions({
          configuredProviders: getConfiguredProviders,
          audioModelIds: getAudioInputModelIds,
        });
      } catch (e) {
        logger.warn("failed to list transcription providers", e);
        // Empty, not a guess. A catalog failure must not advertise a provider
        // whose key we could not confirm — the mic then falls back to the active
        // model's own audio input, which needs no key at all.
        return [];
      }
    },
  );

  ipcMain.handle(
    "voice:transcribe-cloud",
    async (_e, params: TranscribeParams): Promise<TranscribeResult> => {
      try {
        const { provider, mimeType, dataBase64, language } = params;
        const isGoogle = GOOGLE_PROVIDER_IDS.has(provider);
        const providerKeyId = isGoogle ? "google" : provider;
        const apiKey =
          (await getProviderApiKey(providerKeyId)) ??
          (isGoogle ? await getProviderApiKey("gemini") : undefined);
        if (!apiKey) {
          return {
            ok: false,
            error: `No API key set for ${provider}. Add one in Settings → Providers, or pick a model that accepts audio.`,
          };
        }

        const model = await resolveTranscriptionModel(provider, params.model);
        if (!model) {
          return {
            ok: false,
            error: `No speech-to-text model found for ${provider}. Pick another transcription provider, or a model that accepts audio.`,
          };
        }

        if (isGoogle) {
          const text = await transcribeGemini(
            apiKey,
            { mimeType, dataBase64 },
            model,
          );
          return { ok: true, text };
        }

        const baseUrl = await resolveTranscriptionBaseUrl(provider);
        if (!baseUrl) {
          return {
            ok: false,
            error: `No API endpoint known for ${provider}. Pick another transcription provider, or a model that accepts audio.`,
          };
        }
        const bytes = Buffer.from(dataBase64, "base64");
        const audio = new Blob([bytes], { type: mimeType || "audio/webm" });
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

  /**
   * Transcribe through the CHAT MODEL the user is already on.
   *
   * The other route needs a BYOK key for a provider with a speech endpoint. This
   * one needs no key at all: it sends the clip to whatever model is selected, over
   * the same client and the same routing a chat turn uses — which is what makes
   * the mic work on Atlarix Core, where the user has no key to bring.
   *
   * The model is read from SETTINGS, not from the renderer. The renderer knows it
   * too, but taking it over IPC would let a compromised renderer name any model
   * and any provider and have main resolve a key for it.
   *
   * Only reached when the selected model declares `audio` input
   * (`supportsAudioInput`, stamped in main from the models.dev catalog) — a model
   * that cannot hear returns text about an attachment it never received, and the
   * composer hides the mic rather than letting that happen.
   *
   * It bills like any other turn on that model, so the usage is recorded rather
   * than left invisible.
   */
  ipcMain.handle(
    "voice:transcribe-model",
    async (
      _e,
      params: {
        mimeType: string;
        dataBase64: string;
        language?: string;
        /** Only for usage attribution — never for routing. */
        chatId?: number;
      },
    ): Promise<TranscribeResult> => {
      try {
        const { readSettings } = await import("../../main/settings");
        const settings = readSettings();
        const selected = settings.selectedModel;
        if (!selected) {
          return { ok: false, error: "No model selected." };
        }

        const { getModelClient } = await import("../utils/get_model_client");
        const { generateText } = await import("ai");
        const { modelClient } = await getModelClient(selected, settings);

        const languageNote = params.language
          ? ` The audio is in ${params.language}.`
          : "";
        const result = await generateText({
          model: modelClient.model,
          messages: [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  // "Verbatim" and "only the transcript" both matter: a chat model
                  // asked to transcribe will otherwise summarise it, answer it, or
                  // wrap it in "Here is the transcription:".
                  text:
                    "Transcribe the attached audio verbatim." +
                    languageNote +
                    " Output only the transcript text, with no preamble, no" +
                    " commentary and no quotation marks. If there is no speech," +
                    " output nothing.",
                },
                {
                  type: "file" as const,
                  data: params.dataBase64,
                  mediaType: params.mimeType || "audio/webm",
                },
              ],
            },
          ],
        } as Parameters<typeof generateText>[0]);

        const { recordAuxUsage } = await import(
          "@/lib/usage/turn-usage-aggregator"
        );
        recordAuxUsage(params.chatId ?? null, result.usage, "transcription");

        return { ok: true, text: result.text.trim() };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        logger.warn(`model transcription failed: ${error}`);
        return { ok: false, error };
      }
    },
  );
}
