/**
 * `better-sqlite3`'s surface, implemented on `bun:sqlite`: the CLI's database
 * driver.
 *
 * The Bun-compiled CLI cannot load a native Node addon, so scripts/build-bun.ts
 * aliases `better-sqlite3` to this file. Keeping better-sqlite3's API (rather
 * than switching the CLI to drizzle's bun-sqlite driver) means ONE drizzle
 * driver and one set of raw-handle call sites for the desktop and the CLI.
 *
 * Only what this codebase and drizzle's better-sqlite3 driver call is
 * implemented: `prepare` (with `raw()` for drizzle's array rows), `exec`,
 * `pragma`, `transaction`, `backup`, `close`. tests-bun/ covers it under Bun.
 */
// @ts-expect-error -- resolved by Bun at build time; not visible to tsc/Electron.
import { Database as BunDatabase } from "bun:sqlite";

type Params = unknown[];

class Statement {
  constructor(
    private readonly stmt: any,
    private readonly asArrays = false,
  ) {}

  raw(toggle = true): Statement {
    return new Statement(this.stmt, toggle);
  }

  run(...params: Params) {
    return this.stmt.run(...params);
  }

  get(...params: Params) {
    if (this.asArrays) {
      const rows = this.stmt.values(...params);
      return rows.length > 0 ? rows[0] : undefined;
    }
    return this.stmt.get(...params) ?? undefined;
  }

  all(...params: Params) {
    return this.asArrays ? this.stmt.values(...params) : this.stmt.all(...params);
  }

  *iterate(...params: Params) {
    for (const row of this.all(...params)) yield row;
  }
}

export default class Database {
  private readonly db: any;

  constructor(filename: string, options: { timeout?: number; readonly?: boolean } = {}) {
    this.db = new BunDatabase(filename, {
      readonly: options.readonly ?? false,
      create: !options.readonly,
    });
    if (options.timeout) this.db.exec(`PRAGMA busy_timeout = ${Math.floor(options.timeout)}`);
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  /** `pragma("x = y")` sets; `pragma("x", { simple: true })` returns the first value. */
  pragma(source: string, options: { simple?: boolean } = {}) {
    const rows = this.db.prepare(`PRAGMA ${source}`).all();
    if (options.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }
    return rows;
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    return this.db.transaction(fn) as (...args: A) => R;
  }

  async backup(destination: string): Promise<void> {
    this.db.prepare("VACUUM INTO ?").run(destination);
  }

  close(): void {
    this.db.close();
  }

  get open(): boolean {
    return true;
  }
}
