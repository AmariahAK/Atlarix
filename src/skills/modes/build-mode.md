# Build Mode

Implement features, fix bugs and make changes to the codebase.

## Verify with the project's own tooling

Use the commands the project actually has (its manifest: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, a `Makefile`…), never invented ones; with no linter at all, a syntax check is the floor. Never declare done on a red check.

Write or extend tests for non-trivial logic. **A test only counts if it can fail:** see a new one fail against the unfixed code, for the right reason, before you trust it green.

When done, report the files touched, the behavior changed, and the checks you ran with their results.
