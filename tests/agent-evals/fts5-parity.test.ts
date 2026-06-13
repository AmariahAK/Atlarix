/**
 * FTS5 lexical-ranking parity test.
 *
 * Drives the REAL pure query contract from `src/lib/search/fts5-core.ts`
 * (schema, pre-tokenized columns, bm25 column weights, MATCH builder) against an
 * in-memory SQLite FTS5 DB — the same shape `fts5-index.ts` runs in production,
 * minus the electron/ctags/embedding wiring. Asserts the ranking the in-memory
 * wink-bm25 engine used to provide survived the move to disk-backed FTS5:
 *   - a name match outranks a snippet-only match,
 *   - camelCase / snake_case sub-tokens are matchable,
 *   - a symbol whose WHOLE name is generic ("handle") is damped below a specific
 *     match on the same token,
 *   - the candidate-set (restrictToFiles) and per-package WHERE clauses scope as
 *     expected, and FTS5 stays correct + fast over a large symbol set.
 *
 * Lives under tests/agent-evals/ so `better-sqlite3` resolves to the Node-ABI
 * copy (the root build targets Electron's ABI). See vitest.config.ts.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  FTS5_SCHEMA,
  BM25_WEIGHTS,
  INSERT_SQL,
  searchableColumns,
  toMatch,
} from "@/lib/search/fts5-core";

type Sym = {
  name: string;
  signature?: string;
  snippet?: string;
  rel: string;
  line: number;
  pkg?: string;
};

function makeDb(symbols: Sym[]): Database.Database {
  const db = new Database(":memory:");
  db.exec(FTS5_SCHEMA);
  const insert = db.prepare(INSERT_SQL);
  const tx = db.transaction((rows: Sym[]) => {
    for (const s of rows) {
      insert.run(
        ...searchableColumns(s.name, s.signature ?? "", s.snippet ?? s.name),
        `/ws/${s.rel}`,
        s.rel,
        s.line,
        s.pkg ?? ".",
      );
    }
  });
  tx(symbols);
  return db;
}

/** Mirror of `searchFts5`'s query (rel_file projection for readable assertions). */
function search(
  db: Database.Database,
  query: string,
  opts: { restrictToFiles?: string[]; package?: string; limit?: number } = {},
): Array<{ file: string; line: number }> {
  const match = toMatch(query);
  if (!match) return [];
  const where = ["symbols MATCH ?"];
  const params: Array<string | number> = [match];
  if (opts.restrictToFiles?.length) {
    where.push(`abs_file IN (${opts.restrictToFiles.map(() => "?").join(",")})`);
    params.push(...opts.restrictToFiles);
  }
  if (opts.package) {
    where.push("package = ?");
    params.push(opts.package);
  }
  const sql =
    `SELECT rel_file AS file, line, bm25(symbols, ${BM25_WEIGHTS.join(", ")}) AS rank ` +
    `FROM symbols WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`;
  params.push(opts.limit ?? 50);
  return db.prepare(sql).all(...params) as Array<{ file: string; line: number }>;
}

describe("FTS5 lexical ranking parity (fts5-core)", () => {
  it("ranks a name match above a snippet-only match", () => {
    const db = makeDb([
      { name: "renderInvoice", rel: "a.ts", line: 10 },
      { name: "foo", snippet: "build the render invoice view", rel: "b.ts", line: 4 },
    ]);
    const out = search(db, "render invoice");
    expect(out[0].file).toBe("a.ts"); // name column (weight 5) wins
    db.close();
  });

  it("matches camelCase and snake_case sub-tokens", () => {
    const db = makeDb([
      { name: "handleAuthCallback", rel: "auth.ts", line: 42 },
      { name: "renew_user_session", rel: "session.ts", line: 7 },
      { name: "unrelatedThing", rel: "other.ts", line: 1 },
    ]);
    expect(search(db, "auth callback").map((r) => r.file)).toContain("auth.ts");
    expect(search(db, "user session").map((r) => r.file)).toContain("session.ts");
    db.close();
  });

  it("damps a generic whole-name below a specific match on the same token", () => {
    const db = makeDb([
      { name: "handle", rel: "generic.ts", line: 1 }, // whole name generic → name_generic
      { name: "handleSignup", rel: "signup.ts", line: 20 }, // specific → name col
    ]);
    const out = search(db, "handle");
    expect(out.map((r) => r.file)).toEqual(["signup.ts", "generic.ts"]);
    db.close();
  });

  it("restrictToFiles scopes to candidate files (grep candidate-set rerank)", () => {
    const db = makeDb([
      { name: "processPayment", rel: "billing/pay.ts", line: 5 },
      { name: "processPayment", rel: "legacy/pay.ts", line: 9 },
    ]);
    const out = search(db, "process payment", {
      restrictToFiles: ["/ws/billing/pay.ts"],
    });
    expect(out.map((r) => r.file)).toEqual(["billing/pay.ts"]);
    db.close();
  });

  it("package scope restricts to one package root", () => {
    const db = makeDb([
      { name: "createUser", rel: "packages/api/user.ts", line: 3, pkg: "packages/api" },
      { name: "createUser", rel: "packages/web/user.ts", line: 8, pkg: "packages/web" },
    ]);
    const out = search(db, "create user", { package: "packages/api" });
    expect(out.map((r) => r.file)).toEqual(["packages/api/user.ts"]);
    db.close();
  });

  it("stays correct and fast over a large symbol set (scale sanity)", () => {
    const N = 50_000;
    const rows: Sym[] = [];
    for (let i = 0; i < N; i++) {
      rows.push({ name: `handler${i}Worker`, rel: `f${i % 500}.ts`, line: i });
    }
    // One needle in the haystack.
    rows.push({ name: "decodeJwtSignature", rel: "needle.ts", line: 1 });
    const db = makeDb(rows);
    const out = search(db, "decode jwt signature", { limit: 5 });
    expect(out[0].file).toBe("needle.ts");
    db.close();
  });
});
