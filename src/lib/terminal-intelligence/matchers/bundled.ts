/**
 * Bundled Problem Matchers
 * ========================
 * Community-maintained patterns from GitHub Actions.
 * Top 15 languages for 95%+ coverage.
 */

import { type ProblemMatcherFile } from "../matcherEngine";

// ═══════════════════════════════════════════════════════════════════════════
// TYPESCRIPT / TSC
// Source: actions/setup-node
// ═══════════════════════════════════════════════════════════════════════════

export const typescriptMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "tsc",
      pattern: [
        {
          regexp:
            "^([^\\s].*?)\\((\\d+),(\\d+)\\):\\s+(error|warning)\\s+(TS\\d+):\\s+(.*)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          code: 5,
          message: 6,
        },
      ],
    },
    {
      owner: "tsc-relative",
      pattern: [
        {
          regexp:
            "^(.+?):(\\d+):(\\d+)\\s+-\\s+(error|warning)\\s+(TS\\d+):\\s+(.*)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          code: 5,
          message: 6,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// ESLINT
// Source: actions/setup-node
// ═══════════════════════════════════════════════════════════════════════════

export const eslintMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "eslint-compact",
      pattern: [
        {
          regexp:
            "^(.+):\\s+line\\s+(\\d+),\\s+col\\s+(\\d+),\\s+(Error|Warning)\\s+-\\s+(.+)\\s+\\((.+)\\)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          message: 5,
          code: 6,
        },
      ],
    },
    {
      owner: "eslint-stylish",
      severity: "warning",
      pattern: [
        {
          regexp: "^\\s+(\\d+):(\\d+)\\s+(error|warning)\\s+(.+?)\\s+(.+)$",
          line: 1,
          column: 2,
          severity: 3,
          message: 4,
          code: 5,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// PYTHON
// Source: actions/setup-python
// ═══════════════════════════════════════════════════════════════════════════

export const pythonMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "python",
      pattern: [
        {
          regexp: '^\\s*File\\s+"(.+)",\\s+line\\s+(\\d+)',
          file: 1,
          line: 2,
          message: 0,
        },
      ],
    },
    {
      owner: "python-error",
      pattern: [
        {
          regexp: "^(\\w+Error):\\s+(.+)$",
          message: 2,
        },
      ],
    },
    {
      owner: "mypy",
      pattern: [
        {
          regexp: "^(.+):(\\d+):\\s+(error|note):\\s+(.+)$",
          file: 1,
          line: 2,
          severity: 3,
          message: 4,
        },
      ],
    },
    {
      owner: "pytest",
      pattern: [
        {
          regexp: "^FAILED\\s+(.+)::(\\S+)\\s+-\\s+(.+)$",
          file: 1,
          message: 3,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// GO
// Source: actions/setup-go
// ═══════════════════════════════════════════════════════════════════════════

export const goMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "go",
      pattern: [
        {
          regexp: "^([^:]+):(\\d+)(?::(\\d+))?:\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          message: 4,
        },
      ],
    },
    {
      owner: "go-test",
      pattern: [
        {
          regexp: "^---\\s+FAIL:\\s+(\\S+)\\s+\\((.+)\\)$",
          message: 1,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// RUST
// Source: rust-lang/rust
// ═══════════════════════════════════════════════════════════════════════════

export const rustMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "rustc",
      pattern: [
        {
          regexp: "^(error|warning)(?:\\[E(\\d+)\\])?:\\s+(.+)$",
          severity: 1,
          code: 2,
          message: 3,
        },
        {
          regexp: "^\\s+-->\\s+(.+):(\\d+):(\\d+)$",
          file: 1,
          line: 2,
          column: 3,
          message: 0,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// JAVA
// Source: actions/setup-java
// ═══════════════════════════════════════════════════════════════════════════

export const javaMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "javac",
      pattern: [
        {
          regexp: "^(.+\\.java):(\\d+):\\s+(error|warning):\\s+(.+)$",
          file: 1,
          line: 2,
          severity: 3,
          message: 4,
        },
      ],
    },
    {
      owner: "maven",
      pattern: [
        {
          regexp: "^\\[ERROR\\]\\s+(.+):\\[(\\d+),(\\d+)\\]\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          message: 4,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// .NET / C#
// Source: actions/setup-dotnet
// ═══════════════════════════════════════════════════════════════════════════

export const dotnetMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "csc",
      pattern: [
        {
          regexp:
            "^(.+\\.cs)\\((\\d+),(\\d+)\\):\\s+(error|warning)\\s+(CS\\d+):\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          code: 5,
          message: 6,
        },
      ],
    },
    {
      owner: "msbuild",
      pattern: [
        {
          regexp:
            "^(.+)\\((\\d+),(\\d+)\\):\\s+(error|warning)\\s+(\\w+):\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          code: 5,
          message: 6,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// RUBY
// ═══════════════════════════════════════════════════════════════════════════

export const rubyMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "ruby",
      pattern: [
        {
          regexp: "^(.+\\.rb):(\\d+):in\\s+`(.+)':\\s+(.+)$",
          file: 1,
          line: 2,
          message: 4,
        },
      ],
    },
    {
      owner: "rspec",
      pattern: [
        {
          regexp: "^\\s+#\\s+(.+):(\\d+)$",
          file: 1,
          line: 2,
          message: 0,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// PHP
// ═══════════════════════════════════════════════════════════════════════════

export const phpMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "php",
      pattern: [
        {
          regexp:
            "^(Parse|Fatal|Warning|Notice)\\s+error:\\s+(.+)\\s+in\\s+(.+)\\s+on\\s+line\\s+(\\d+)$",
          severity: 1,
          message: 2,
          file: 3,
          line: 4,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// SWIFT
// ═══════════════════════════════════════════════════════════════════════════

export const swiftMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "swift",
      pattern: [
        {
          regexp: "^(.+\\.swift):(\\d+):(\\d+):\\s+(error|warning):\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          message: 5,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// KOTLIN
// ═══════════════════════════════════════════════════════════════════════════

export const kotlinMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "kotlin",
      pattern: [
        {
          regexp: "^e:\\s+(.+\\.kts?):\\s+\\((\\d+),\\s+(\\d+)\\):\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          message: 4,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// DART / FLUTTER
// ═══════════════════════════════════════════════════════════════════════════

export const dartMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "dart",
      pattern: [
        {
          regexp: "^(.+\\.dart):(\\d+):(\\d+):\\s+(Error|Warning):\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          message: 5,
        },
      ],
    },
    {
      owner: "flutter",
      pattern: [
        {
          regexp: "^\\[ERROR:flutter/(.+)\\]\\s+(.+)$",
          file: 1,
          message: 2,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// SCALA / SBT
// ═══════════════════════════════════════════════════════════════════════════

export const scalaMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "scala",
      pattern: [
        {
          regexp: "^\\[error\\]\\s+(.+\\.scala):(\\d+):(\\d+):\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          message: 4,
        },
      ],
    },
    {
      owner: "sbt",
      pattern: [
        {
          regexp: "^\\[error\\]\\s+(.+)$",
          message: 1,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// ELIXIR / PHOENIX
// ═══════════════════════════════════════════════════════════════════════════

export const elixirMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "elixir",
      pattern: [
        {
          regexp: "^\\*\\*\\s+\\((\\w+Error)\\)\\s+(.+):(\\d+):\\s+(.+)$",
          severity: 1,
          file: 2,
          line: 3,
          message: 4,
        },
      ],
    },
    {
      owner: "mix",
      pattern: [
        {
          regexp: "^\\((.+?)\\)\\s+(.+):(\\d+):\\s+(.+)$",
          file: 2,
          line: 3,
          message: 4,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// HASKELL / GHC
// ═══════════════════════════════════════════════════════════════════════════

export const haskellMatcher: ProblemMatcherFile = {
  problemMatcher: [
    {
      owner: "ghc",
      pattern: [
        {
          regexp: "^(.+\\.hs):(\\d+):(\\d+):\\s+(error|warning):\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          message: 5,
        },
      ],
    },
    {
      owner: "stack",
      pattern: [
        {
          regexp: "^(.+):(\\d+):(\\d+):\\s+(.+)$",
          file: 1,
          line: 2,
          column: 3,
          message: 4,
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// ALL MATCHERS (15 LANGUAGES)
// ═══════════════════════════════════════════════════════════════════════════

export const ALL_MATCHERS: ProblemMatcherFile[] = [
  typescriptMatcher,
  eslintMatcher,
  pythonMatcher,
  goMatcher,
  rustMatcher,
  javaMatcher,
  dotnetMatcher,
  rubyMatcher,
  phpMatcher,
  swiftMatcher,
  kotlinMatcher,
  dartMatcher,
  scalaMatcher,
  elixirMatcher,
  haskellMatcher,
];
