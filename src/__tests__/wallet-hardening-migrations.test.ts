/**
 * Wallet hardening (audit 2026-11-06). Each guard reads the NEWEST definition in
 * supabase/migrations, so a later rewrite that drops one of these properties fails here.
 *
 *  1. No user writes ledger rows: the proxy charges users through debit_wallet_service,
 *     which gets debit_wallet's -$50 floor; a separate, later file revokes debit_wallet
 *     from authenticated (applied only once the proxy no longer calls it).
 *  2. The wallet row is locked (FOR UPDATE) before the duplicate and floor checks, so
 *     two concurrent debits cannot both pass a floor only one of them fits under.
 *  3. A ban does not drop a served charge: the debits no longer refuse banned accounts
 *     (the ban gates NEW turns at the balance read; docs/DESIGN_NOTES.md "Account bans").
 *  4. Paid holds for the Lambda failover live in the DB: a table no client can reach and
 *     two service-only RPCs.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../../supabase/migrations");
const files = (): string[] => fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const read = (f: string): string => fs.readFileSync(path.join(DIR, f), "utf8");

/** The newest `CREATE [OR REPLACE] FUNCTION public.<name>(` and the file it is in. */
function newest(name: string): { file: string; sql: string; head: string; body: string } {
  let hit: { file: string; sql: string; head: string; body: string } | null = null;
  const re = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.${name}\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\2\$`,
    "gi",
  );
  for (const file of files()) {
    const sql = read(file);
    for (const m of sql.matchAll(re)) hit = { file, sql, head: m[1]!, body: m[3]! };
  }
  if (!hit) throw new Error(`no definition of public.${name}`);
  return hit;
}

/** Statements that do something (comments stripped). */
const code = (s: string): string => s.replace(/--[^\n]*/g, "");

const DEBITS = ["debit_wallet", "debit_wallet_service", "debit_wallet_cloud"] as const;
const PAYER: Record<(typeof DEBITS)[number], string> = {
  debit_wallet: "uid",
  debit_wallet_service: "p_user_id",
  debit_wallet_cloud: "p_user_id",
};

describe("debit functions (newest definitions)", () => {
  for (const fn of DEBITS) {
    it(`${fn}: no ban refusal — a served charge stands`, () => {
      expect(code(newest(fn).body)).not.toMatch(/account_is_banned/);
    });

    it(`${fn}: locks the payer's wallet row before the duplicate and floor checks`, () => {
      const body = code(newest(fn).body);
      const lock = body.search(
        new RegExp(String.raw`FROM\s+(?:public\.)?credit_wallet\s+WHERE\s+user_id\s*=\s*${PAYER[fn]}\s+FOR\s+UPDATE`, "i"),
      );
      const ensure = body.search(/INSERT\s+INTO\s+(?:public\.)?credit_wallet\b/i);
      const ledger = body.search(/INSERT\s+INTO\s+(?:public\.)?credit_transactions\b/i);
      expect(lock).toBeGreaterThan(-1);
      expect(ensure).toBeGreaterThan(-1);
      expect(lock).toBeGreaterThan(ensure);
      expect(lock).toBeLessThan(ledger);
      const dup = body.search(/IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:public\.)?credit_transactions/i);
      if (dup > -1) expect(lock).toBeLessThan(dup);
      const floor = body.search(/DEBIT_FLOOR_CENTS\s+THEN/i);
      if (floor > -1) expect(lock).toBeLessThan(floor);
    });

    it(`${fn}: keeps search_path pinned and SECURITY DEFINER`, () => {
      const { head } = newest(fn);
      expect(head).toMatch(/SECURITY\s+DEFINER/i);
      expect(head).toMatch(/SET\s+search_path\s+TO\s+'public'/i);
    });

    it(`${fn}: keeps its amount, ref and caller checks`, () => {
      const body = code(newest(fn).body);
      for (const e of ["invalid_amount", "amount_too_large", "missing_generation_id"]) expect(body).toContain(e);
      expect(body).toMatch(/DEBIT_MAX_CENTS\s+CONSTANT\s+bigint\s*:=\s*5000/i);
      expect(body).toMatch(/ON\s+CONFLICT\s*\(\s*kind\s*,\s*ref\s*\)\s+DO\s+NOTHING/i);
      if (fn === "debit_wallet") expect(body).toContain("not_authenticated");
      else expect(body).toMatch(/auth\.role\(\)[\s\S]*service_role[\s\S]*forbidden/);
    });
  }

  it("debit_wallet_service has debit_wallet's -$50 floor, checked after the duplicate check", () => {
    const body = code(newest("debit_wallet_service").body);
    expect(body).toMatch(/DEBIT_FLOOR_CENTS\s+CONSTANT\s+bigint\s*:=\s*-5000/i);
    expect(body).toMatch(/wallet_spendable\(p_user_id\)\s*-\s*p_cents\s*<\s*DEBIT_FLOOR_CENTS/i);
    expect(body).toContain("insufficient_funds");
    // A retried charge whose wallet is now below the floor is still a duplicate, not a refusal.
    const dup = body.search(/IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:public\.)?credit_transactions/i);
    expect(dup).toBeGreaterThan(-1);
    expect(dup).toBeLessThan(body.search(/DEBIT_FLOOR_CENTS\s+THEN/i));
  });

  it("debit_wallet_service still accepts the user surfaces and billings the proxy sends", () => {
    const body = code(newest("debit_wallet_service").body);
    for (const s of ["'app'", "'cli'", "'extension'", "'reviewer'", "'cloud'"]) expect(body).toContain(s);
    for (const b of ["'auto_paid'", "'core'", "'tool'"]) expect(body).toContain(b);
  });

  it("each rewritten debit function repeats its REVOKE/GRANT lines in the same file", () => {
    const sig: Record<(typeof DEBITS)[number], string> = {
      debit_wallet: "public.debit_wallet(text, bigint, text, text)",
      debit_wallet_service: "public.debit_wallet_service(uuid, text, bigint, text, text, text, uuid, text, text)",
      debit_wallet_cloud: "public.debit_wallet_cloud(uuid, uuid, text, bigint, text, uuid, text, text)",
    };
    for (const fn of DEBITS) {
      const { sql } = newest(fn);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig[fn]} FROM PUBLIC, anon`);
      if (fn !== "debit_wallet") {
        expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig[fn]} FROM PUBLIC, anon, authenticated;`);
        expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig[fn]} TO service_role;`);
      }
    }
  });
});

describe("no user writes ledger rows", () => {
  const REVOKE = "REVOKE EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text, text) FROM authenticated, anon, PUBLIC;";

  it("a migration revokes debit_wallet from authenticated", () => {
    expect(files().some((f) => read(f).includes(REVOKE))).toBe(true);
  });

  it("the revoke is its own file, later than the debit rewrite, and nothing after it grants debit_wallet back", () => {
    const all = files();
    const at = all.findIndex((f) => read(f).includes(REVOKE));
    const rewrite = all.indexOf(newest("debit_wallet").file);
    expect(at).toBeGreaterThan(rewrite);
    expect(code(read(all[at]!)).match(/\b(CREATE|ALTER|GRANT)\b/gi) ?? []).toEqual([]);
    for (const f of all.slice(at + 1)) {
      expect(code(read(f))).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.debit_wallet\s*\([^)]*\)\s+TO\s+[^;]*authenticated/i);
    }
  });
});

describe("paid holds (Lambda failover)", () => {
  const holdsFile = (): string => {
    const f = files().find((x) => /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.paid_holds\b/i.test(read(x)));
    if (!f) throw new Error("no paid_holds table");
    return read(f);
  };

  it("the table has the agreed columns, RLS on and no policy", () => {
    const sql = code(holdsFile());
    expect(sql).toMatch(/id\s+uuid\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i);
    expect(sql).toMatch(/user_id\s+uuid\s+NOT\s+NULL/i);
    expect(sql).toMatch(/cents\s+bigint\s+NOT\s+NULL\s+CHECK\s*\(\s*cents\s*>\s*0\s*\)/i);
    expect(sql).toMatch(/expires_at\s+timestamptz\s+NOT\s+NULL/i);
    expect(sql).toMatch(/ALTER\s+TABLE\s+public\.paid_holds\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    for (const f of files()) expect(code(read(f))).not.toMatch(/CREATE\s+POLICY[^;]*ON\s+(?:public\.)?paid_holds\b/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+(?:TABLE\s+)?public\.paid_holds\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i);
  });

  const RPCS = {
    take_paid_hold_service: "public.take_paid_hold_service(uuid, bigint, integer)",
    release_paid_hold_service: "public.release_paid_hold_service(uuid)",
  } as const;

  for (const [fn, sig] of Object.entries(RPCS)) {
    it(`${fn}: service-only, SECURITY DEFINER, search_path pinned`, () => {
      const { head, body, sql } = newest(fn);
      expect(head).toMatch(/SECURITY\s+DEFINER/i);
      expect(head).toMatch(/SET\s+search_path\s+TO\s+'public'/i);
      expect(code(body)).toMatch(/IF\s+COALESCE\(auth\.role\(\),\s*''\)\s*<>\s*'service_role'\s+THEN\s+RETURN\s+jsonb_build_object\('ok',\s*false,\s*'error',\s*'forbidden'\)/i);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
    });
  }

  it("take_paid_hold_service locks the wallet, sweeps expired holds, and refuses what the balance cannot cover", () => {
    const body = code(newest("take_paid_hold_service").body);
    const lock = body.search(/FROM\s+(?:public\.)?credit_wallet\s+WHERE\s+user_id\s*=\s*p_user_id\s+FOR\s+UPDATE/i);
    const sweep = body.search(/DELETE\s+FROM\s+(?:public\.)?paid_holds\s+WHERE\s+user_id\s*=\s*p_user_id\s+AND\s+expires_at\s*<=\s*now\(\)/i);
    const sum = body.search(/SUM\(cents\)[\s\S]*FROM\s+(?:public\.)?paid_holds/i);
    const insert = body.search(/INSERT\s+INTO\s+(?:public\.)?paid_holds/i);
    expect(lock).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(lock);
    expect(sum).toBeGreaterThan(sweep);
    expect(insert).toBeGreaterThan(sum);
    expect(body).toMatch(/wallet_spendable\(p_user_id\)/);
    expect(body).toMatch(/-\s*held\s*-\s*p_cents\s*<\s*0/i);
    expect(body).toContain("'insufficient_funds'");
    expect(body).toMatch(/'hold_id'/);
  });
});
