/**
 * Static analysis for Reviewer: security patterns (regex-based, no LLM).
 * Run async on file write; report to Activity Stream. Optional: ast-grep/oxlint later.
 */

export interface ReviewIssue {
  severity: "error" | "warning" | "info";
  rule: string;
  line: number;
  file: string;
  message: string;
  fix?: string;
}

const PATTERNS: Array<{
  rule: string;
  severity: ReviewIssue["severity"];
  regex: RegExp;
  message: string;
  fix?: string;
}> = [
  {
    rule: "hardcoded_secret",
    severity: "error",
    regex: /(?:const|let|var)\s+\w*[kK]ey\w*\s*=\s*['"][^'"]{8,}['"]/g,
    message: "Possible hardcoded secret",
    fix: "Use env var or credential store",
  },
  {
    rule: "eval_usage",
    severity: "error",
    regex: /\beval\s*\(/g,
    message: "eval() is unsafe",
    fix: "Avoid eval; use JSON.parse or safe alternatives",
  },
  {
    rule: "innerHTML_assignment",
    severity: "warning",
    regex: /\.innerHTML\s*=/g,
    message: "innerHTML assignment can cause XSS",
    fix: "Use textContent or sanitize",
  },
  {
    rule: "proto_pollution",
    severity: "warning",
    regex: /['"]__proto__['"]|\[['"]__proto__['"]\]/g,
    message: "Prototype pollution risk",
    fix: "Avoid __proto__ access",
  },
];

/**
 * Run static checks on file content. Returns issues; does not block.
 */
export function runStaticAnalysis(
  filePath: string,
  content: string
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const lines = content.split("\n");

  for (const { rule, severity, regex, message, fix } of PATTERNS) {
    lines.forEach((line, i) => {
      regex.lastIndex = 0;
      if (regex.test(line)) {
        issues.push({
          severity,
          rule,
          line: i + 1,
          file: filePath,
          message,
          fix,
        });
      }
    });
  }

  return issues;
}
