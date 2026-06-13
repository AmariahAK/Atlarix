/**
 * Loader for the on-device Model2Vec `potion-code-16M` static-embedding model.
 *
 * No external dependency: a pure-JS BERT-uncased WordPiece tokenizer (the model's
 * tokenizer.json is a standard WordPiece — BertNormalizer + BertPreTokenizer, no
 * special tokens) + a tiny safetensors reader. Inference is Model2Vec's weighted
 * mean of token embeddings (per-token SIF `weights`), L2-normalized.
 *
 * Files (bundled via forge extraResource, fetched by scripts/fetch-model2vec.mjs):
 *   model.safetensors  — embeddings F32 [V,256] + weights F64 [V] (+ identity mapping)
 *   tokenizer.json     — WordPiece vocab + config
 */

import * as fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import type { StaticEmbeddingModel } from "./static-embeddings";

const logger = log.scope("model2vec");

const UNK = "[UNK]";
const MAX_WORD_CHARS = 100;

// ── BERT-uncased normalization ──────────────────────────────────────────────

function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}

/** clean_text + handle_chinese_chars + strip_accents + lowercase. */
function bertNormalize(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd) continue; // invalid
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out += " "; // control whitespace → space
      continue;
    }
    if (cp < 0x20) continue; // other control chars
    if (isChineseChar(cp)) {
      out += ` ${ch} `; // isolate CJK
      continue;
    }
    out += ch;
  }
  // strip accents (lowercase ⇒ strip_accents true) then lowercase.
  out = out.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return out.toLowerCase();
}

/** BertPreTokenizer: split on whitespace, isolate punctuation into own tokens. */
function bertPreTokenize(text: string): string[] {
  const words: string[] = [];
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    let cur = "";
    for (const ch of chunk) {
      if (/[^\p{L}\p{N}]/u.test(ch) && !/\s/.test(ch)) {
        if (cur) {
          words.push(cur);
          cur = "";
        }
        words.push(ch); // punctuation is its own token
      } else {
        cur += ch;
      }
    }
    if (cur) words.push(cur);
  }
  return words;
}

/** Greedy longest-match WordPiece with `##` continuation. */
function wordPiece(word: string, vocab: Map<string, number>): number[] {
  if (word.length > MAX_WORD_CHARS) return [vocab.get(UNK)!];
  const ids: number[] = [];
  let start = 0;
  const chars = [...word];
  while (start < chars.length) {
    let end = chars.length;
    let curId: number | undefined;
    while (start < end) {
      const sub = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
      const id = vocab.get(sub);
      if (id !== undefined) {
        curId = id;
        break;
      }
      end--;
    }
    if (curId === undefined) return [vocab.get(UNK)!]; // unmatchable → whole word UNK
    ids.push(curId);
    start = end;
  }
  return ids;
}

function makeTokenizer(vocab: Map<string, number>): (text: string) => number[] {
  return (text: string) => {
    const ids: number[] = [];
    for (const word of bertPreTokenize(bertNormalize(text))) {
      ids.push(...wordPiece(word, vocab));
    }
    return ids;
  };
}

// ── safetensors ─────────────────────────────────────────────────────────────

interface SafeTensors {
  embeddings: Float32Array; // V*dim
  weights: Float32Array; // V
  dim: number;
  vocabSize: number;
}

function readSafetensors(file: string): SafeTensors {
  const fd = fs.openSync(file, "r");
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    const headerBuf = Buffer.alloc(headerLen);
    fs.readSync(fd, headerBuf, 0, headerLen, 8);
    const header = JSON.parse(headerBuf.toString("utf8")) as Record<
      string,
      { dtype: string; shape: number[]; data_offsets: [number, number] }
    >;
    const base = 8 + headerLen;

    const emb = header.embeddings;
    const [vocabSize, dim] = emb.shape;
    const embBuf = Buffer.alloc(emb.data_offsets[1] - emb.data_offsets[0]);
    fs.readSync(fd, embBuf, 0, embBuf.length, base + emb.data_offsets[0]);
    const embeddings = new Float32Array(
      embBuf.buffer,
      embBuf.byteOffset,
      vocabSize * dim,
    );

    const w = header.weights;
    const wBuf = Buffer.alloc(w.data_offsets[1] - w.data_offsets[0]);
    fs.readSync(fd, wBuf, 0, wBuf.length, base + w.data_offsets[0]);
    const weights = new Float32Array(vocabSize);
    for (let i = 0; i < vocabSize; i++) weights[i] = wBuf.readDoubleLE(i * 8);

    return { embeddings, weights, dim, vocabSize };
  } finally {
    fs.closeSync(fd);
  }
}

// ── public ──────────────────────────────────────────────────────────────────

/** Load the Model2Vec model from a directory containing the model + tokenizer. */
export function loadModel2Vec(dir: string): StaticEmbeddingModel | null {
  try {
    const tokPath = path.join(dir, "tokenizer.json");
    const stPath = path.join(dir, "model.safetensors");
    if (!fs.existsSync(tokPath) || !fs.existsSync(stPath)) return null;

    const tok = JSON.parse(fs.readFileSync(tokPath, "utf8")) as {
      model: { vocab: Record<string, number> };
    };
    const vocab = new Map<string, number>(Object.entries(tok.model.vocab));
    if (!vocab.has(UNK)) {
      logger.warn("Model2Vec tokenizer missing [UNK]; aborting load");
      return null;
    }
    const { embeddings, weights, dim, vocabSize } = readSafetensors(stPath);
    const tokenize = makeTokenizer(vocab);

    logger.info(`Loaded Model2Vec: ${vocabSize} tokens × ${dim} dims`);
    return {
      dim,
      tokenize,
      vectorAt(id: number) {
        if (id < 0 || id >= vocabSize) return undefined;
        return embeddings.subarray(id * dim, id * dim + dim);
      },
      weightAt(id: number) {
        return id >= 0 && id < vocabSize ? weights[id]! : 0;
      },
    };
  } catch (e) {
    logger.warn("Model2Vec load failed:", e);
    return null;
  }
}

/** Resolve the bundled model dir (packaged Resources, else repo assets). */
export function resolveModel2VecDir(): string | null {
  const candidates: string[] = [];
  const resources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resources) {
    candidates.push(path.join(resources, "model2vec", "potion-code-16M"));
  }
  candidates.push(
    path.join(process.cwd(), "assets", "model2vec", "potion-code-16M"),
  );
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "model.safetensors"))) return c;
  }
  return null;
}
