/**
 * Validation before executing model-supplied or remote SQL.
 * Complements parameterized Drizzle usage elsewhere — not a substitute for prepared statements here.
 */

const MAX_SQL_CHARS = 100_000;

const DANGEROUS_PATTERNS: RegExp[] = [
  /\bINTO\s+OUTFILE\b/i,
  /\bINTO\s+DUMPFILE\b/i,
  /\bLOAD_FILE\s*\(/i,
  /\bBENCHMARK\s*\(\s*\d{3,}/i,
  /\bSLEEP\s*\(\s*\d{4,}\s*\)/i,
  /\bPG_SLEEP\s*\(\s*\d{4,}/i,
  /\bWAITFOR\s+DELAY\b/i,
  /\bXP_CMDSHELL\b/i,
  /\bSP_EXECUTESQL\b.*;\s*\w+/i,
  /\bCOPY\s+[^\n]+\s+TO\s+PROGRAM\b/i,
  /\bPG_READ_FILE\s*\(/i,
  /\bLO_IMPORT\s*\(/i,
  /\bLO_EXPORT\s*\(/i,
];

/**
 * Remove NULs, trim, enforce max length.
 */
export function normalizeSqlInput(sql: string): string {
  const s = sql.replace(/\0/g, "").trim();
  if (s.length > MAX_SQL_CHARS) {
    throw new Error(`SQL exceeds maximum length (${MAX_SQL_CHARS} characters)`);
  }
  return s;
}

/**
 * Count semicolons that terminate statements (outside single-quoted strings and line comments).
 * Heuristic — sufficient to block `SELECT 1; DROP TABLE x` style stacking.
 */
export function countStatementDelimiters(sql: string): number {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  let lineComment = false;
  let blockComment = 0;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (c === "\n" || c === "\r") lineComment = false;
      continue;
    }
    if (blockComment > 0) {
      if (c === "*" && next === "/") {
        blockComment--;
        i++;
      }
      continue;
    }

    if (!inSingle && !inDouble) {
      if (c === "-" && next === "-") {
        lineComment = true;
        i++;
        continue;
      }
      if (c === "/" && next === "*") {
        blockComment++;
        i++;
        continue;
      }
    }

    if (!inDouble && c === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (inSingle) {
      if (c === "'" && sql[i + 1] === "'") {
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }

    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && c === ";") {
      count++;
    }
  }
  return count;
}

/**
 * Validate SQL before sending to Supabase management / remote execution (may include DDL).
 */
export function assertSqlSafeForRemoteExecution(sql: string): string {
  const normalized = normalizeSqlInput(sql);
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(normalized)) {
      throw new Error("This SQL pattern is not allowed for security reasons.");
    }
  }
  const withoutTrailingSemicolon = normalized.replace(/;\s*$/g, "").trim();
  if (countStatementDelimiters(withoutTrailingSemicolon) > 0) {
    throw new Error("Multiple SQL statements in one batch are not allowed.");
  }
  return normalized;
}

/**
 * Read-only queries only (e.g. future db_query tool paths).
 */
export function assertSafeReadOnlySql(sql: string): string {
  const normalized = assertSqlSafeForRemoteExecution(sql);
  const stripped = normalized
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  const lead = stripped.replace(/^\s*\(\s*/g, "").trimStart();
  const upper = lead.slice(0, 12).toUpperCase();
  if (!upper.startsWith("SELECT") && !upper.startsWith("WITH") && !upper.startsWith("SHOW") && !upper.startsWith("EXPLAIN")) {
    throw new Error("Only read-only SQL (SELECT, WITH, SHOW, EXPLAIN) is allowed.");
  }
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i;
  if (forbidden.test(normalized)) {
    throw new Error("Write or DDL keywords are not allowed in read-only SQL.");
  }
  return normalized;
}

