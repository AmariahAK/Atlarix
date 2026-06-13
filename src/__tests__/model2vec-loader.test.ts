import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { loadModel2Vec } from "@/lib/search/model2vec-loader";
import { cosineSim, embedText } from "@/lib/search/static-embeddings";

const MODEL_DIR = path.join(
  process.cwd(),
  "assets",
  "model2vec",
  "potion-code-16M",
);
const HAS_MODEL = fs.existsSync(path.join(MODEL_DIR, "model.safetensors"));

// The model is a build artifact (npm run fetch-model2vec), not committed — skip
// gracefully when absent so CI without the model stays green.
describe.skipIf(!HAS_MODEL)("Model2Vec loader (real potion-code-16M)", () => {
  const model = loadModel2Vec(MODEL_DIR)!;

  it("loads a 256-dim model with a working WordPiece tokenizer", () => {
    expect(model).not.toBeNull();
    expect(model.dim).toBe(256);
    // "function" and "the" are single known vocab tokens.
    expect(model.tokenize("function the")).toEqual([2856, 999]);
    // Unknown gibberish still tokenizes (WordPiece pieces / [UNK]).
    expect(model.tokenize("zzqqxx").length).toBeGreaterThan(0);
  });

  it("embeds to a normalized 256-d vector", () => {
    const v = embedText(model, "async function authenticateUser(token)")!;
    expect(v.length).toBe(256);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 4);
  });

  it("scores semantically related code higher than unrelated text", () => {
    const query = embedText(model, "function that handles user authentication and login")!;
    const related = embedText(model, "def authenticate(user, password): verify credentials and create a session")!;
    const unrelated = embedText(model, "a recipe for chocolate cake with sugar, flour, and eggs")!;
    const simRelated = cosineSim(query, related);
    const simUnrelated = cosineSim(query, unrelated);
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });
});
