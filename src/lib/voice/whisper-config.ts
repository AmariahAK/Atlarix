/**
 * On-device Whisper pipeline configuration.
 *
 * Extracted from `whisper-worker.ts` so it can be asserted in tests — the node vitest
 * project cannot spawn a DOM Worker, and what lives here is the exact combination that
 * made on-device voice unusable. See `src/__tests__/voice-worker-recovery.test.ts`.
 */

export type WhisperDevice = "webgpu" | "wasm";

/**
 * `whisper-small` (244M) rather than `base` (74M). Base transcribes roughly the
 * right words and gets technical vocabulary wrong often enough to need editing,
 * which defeats the point of dictating. Small is a large accuracy step for a
 * one-time ~285 MB fetch that is cached permanently and works offline afterwards.
 */
export const WHISPER_MODEL = "onnx-community/whisper-small";

/**
 * ONE dtype, for BOTH devices — and it must not be an int8 variant.
 *
 * ## What was broken
 *
 * The WASM (CPU) fallback could never build a session, on ANY platform. ONNX Runtime's
 * `extended` graph-optimization level — inside its default `all` — runs
 * `TransposeDQWeightsForMatMulNBits`, and that transform is broken for Whisper's *merged*
 * decoder in the pinned `onnxruntime-web@1.26.0-dev.20260416`. Every int8 variant died at
 * session creation with:
 *
 *   Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: qdq_actions.cc:137
 *   TransposeDQWeightsForMatMulNBits Missing required scale:
 *   model.decoder.embed_tokens.weight_merged_0_scale for node:
 *   model.decoder.embed_tokens.weight_transposed_DequantizeLinear
 *
 * That is the error users reported on Windows. It was attributed to the Windows GPU being
 * unable to execute the 4-bit `MatMulNBits` operator, and to the q4 decoder. Both were
 * wrong: it is the CPU-side int8 path, it reproduces on macOS, and q4 is the ESCAPE from
 * it — q4 already *is* `MatMulNBits`, so there is no dequantized weight to transpose and
 * the broken transform never runs.
 *
 * macOS only looked healthy because it has working WebGPU and so never reached the
 * fallback. Electron 38 (Chromium 140) enables WebGPU on Linux by default, so Linux was
 * in the same position as Windows: fine until it wasn't.
 *
 * ## Why q4 for both, measured rather than assumed
 *
 * whisper-small, an 11s clip of real speech, `num_beams: 4`, warm cache (macOS):
 *
 *   q4    on webgpu   → session 2.5s,  transcribe  1.8s   ✅  (this config)
 *   q4    on wasm     → session 11.3s, transcribe 15.5s   ✅  (the fallback)
 *   q8    on wasm @ basic     → transcribe 11.6s          ✅  but see below
 *   q8    on wasm @ default   → FAILS                     ❌  what shipped
 *   uint8 on wasm @ default   → FAILS                     ❌
 *   q8    on webgpu           → transcribe 16.6s          ✅  but 8x slower than q4
 *   fp32 encoder + q4 decoder on webgpu → transcribe 2.0s ✅  the OLD config
 *
 * Every one of those produced a character-identical transcript, so this costs no accuracy.
 *
 * Three things fall out, and they all point the same way:
 *  - **int8 is a trap on WebGPU**, not just on CPU: 16.6s vs 1.8s. WebGPU has no efficient
 *    int8 kernels, while `MatMulNBits` has a dedicated one. "q8 everywhere" would have
 *    fixed Windows by making every Mac 8x slower.
 *  - **q4 needs no session-option override.** Capping WASM at `graphOptimizationLevel:
 *    "basic"` also works, but only because it dodges the crashing pass; q4 removes the
 *    reason to dodge it, so there is no workaround to carry.
 *  - **ONE download.** Both devices want `encoder_model_q4.onnx` (63.1 MB) +
 *    `decoder_model_merged_q4.onnx` (222.3 MB). The old config asked for a 336.5 MB fp32
 *    encoder on WebGPU and int8 on WASM, so a machine that failed over fetched a second
 *    set of weights: 559 MB, then 238 MB more — 797 MB on a machine that was always going
 *    to run on CPU. Now a WebGPU failure re-downloads nothing.
 *
 * NOT fp16: the Whisper DECODER is broken in fp16 on WebGPU — a blanket fp16 produces
 * degenerate output ("I'm not." for real speech). That is why the dtype used to be
 * per-component at all.
 */
export const WHISPER_DTYPE = "q4" as const;

/**
 * dtypes that must never be used on the WASM device.
 *
 * These are the int8 families whose dequantized weights trigger the broken
 * `TransposeDQWeightsForMatMulNBits` pass above. Exported so the regression test names
 * the actual hazard rather than restating the current value.
 */
export const WASM_FORBIDDEN_DTYPES = ["q8", "int8", "uint8"] as const;

export interface WhisperPipelineOptions {
  device: WhisperDevice;
  dtype: typeof WHISPER_DTYPE;
}

/**
 * Pipeline options for a device. Deliberately device-shaped even though both devices
 * agree, so any future divergence has one place to live — and one place for the test that
 * asserts WASM never gets an int8 dtype.
 */
export function buildPipelineOptions(
  device: WhisperDevice,
): WhisperPipelineOptions {
  return { device, dtype: WHISPER_DTYPE };
}
