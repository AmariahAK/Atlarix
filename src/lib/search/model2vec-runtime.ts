/**
 * Lazy activation of the on-device Model2Vec semantic-recall lane.
 *
 * Loads the bundled model once (the ~64MB safetensors read) the first time
 * retrieval runs WITH the `semanticRecall` setting on, registers it globally,
 * and is a cheap no-op otherwise. When off / unavailable, retrieval stays on
 * Blueprint Tier-1 (BM25 + structural).
 */

import log from "electron-log";
import { readSettings } from "@/main/settings";
import { loadModel2Vec, resolveModel2VecDir } from "./model2vec-loader";
import {
  hasStaticEmbeddingModel,
  setStaticEmbeddingModel,
} from "./static-embeddings";

const logger = log.scope("model2vec");

let loadFailed = false;

function semanticRecallEnabled(): boolean {
  try {
    return readSettings().semanticRecall === true;
  } catch {
    return false;
  }
}

/**
 * Returns true when an embedding model is active for this turn. Loads it on
 * first enabled use; never retries a failed load (avoids re-reading 64MB).
 */
export function ensureSemanticModel(): boolean {
  if (!semanticRecallEnabled()) return false;
  if (hasStaticEmbeddingModel()) return true;
  if (loadFailed) return false;
  const dir = resolveModel2VecDir();
  if (!dir) {
    loadFailed = true;
    logger.info("semanticRecall on but no Model2Vec model bundled — Tier-1 only");
    return false;
  }
  const model = loadModel2Vec(dir);
  if (!model) {
    loadFailed = true;
    return false;
  }
  setStaticEmbeddingModel(model);
  return true;
}
