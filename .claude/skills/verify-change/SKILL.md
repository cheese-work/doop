---
name: verify-change
description: Prove a change to doop works before you call it done or mark a PR ready. Runs the tests tied to the changed files, then the repo's own typecheck, lint, format, doc-lint and build gates, and says which gate failed. Use after any code change in doop, and before writing the proof section of a PR.
---

<!-- Idea from pstack's create-verification-skill / maintain-verification-skill (Lauren Tan, MIT; https://github.com/cursor/plugins at ae5650f). Written fresh for doop, no text copied. -->

# Verify a doop change

Proof means a command you ran and output you read. "Should work" is not proof.

## Run

1. Work on X99. Do not build or run this on C00.
2. `bun install --frozen-lockfile` once per checkout. `bun` lives in `~/.bun/bin`.
3. Commit your work, then run `.claude/skills/verify-change/verify.sh` (base defaults to `origin/main`; pass another ref as the first argument).
4. Read the `:::` lines. Each gate prints `PASS`, `FAIL` or `SKIP`; the last line is `VERIFY PASS` or `VERIFY FAIL`.

The script runs exactly what CI runs, narrowed to your diff:

| Gate         | Command                                                              | Same as CI job |
| ------------ | -------------------------------------------------------------------- | -------------- |
| related-tests | `vitest related --run <changed ts/tsx>` (module graph, not filename) | test           |
| typecheck    | `bun run typecheck`                                                  | typecheck      |
| lint         | `bun run lint`                                                       | lint           |
| format       | `prettier --check` on changed files                                  | lint           |
| doc-lint     | `bun run doc-lint`                                                   | lint           |
| build        | `bun run --bun build`, only if `src/`, `shared/`, `public/`, `scripts/` or build config changed | build |

The full suite and the PR-title commitlint check stay with CI. Do not add CI jobs here.

## Prove behavior, not just gates

- New behavior or bug fix: write the failing test first, run `bunx vitest run <file>`, keep the red output, fix, keep the green output. Test the behavior a caller sees, not the internals.
- UI change: tests are not enough. `bun run dev` (zero-config, pglite; web `:4300`, API `:4400`), open the page, do the user action, and capture what you saw. Check the ports are free first (`ss -ltn | grep -E ':4300|:4400'`) and stop only the process you started.
- Never weaken or skip a test to get green.

## Reading failures

- `typecheck`, `lint`, `format`, `doc-lint` failures are real. Fix them.
- The script skips test files that import `puppeteer` (real Chromium). `related` reaches them through hub files like `src/lib/api.ts`, and on a loaded shared X99 they time out (`Navigation timeout`, `Hook timed out`) in changes that never touch them. If your diff touches canvas, frame or editor UI, run the matching files by hand: `bunx vitest run --maxWorkers=1 tests/<area>Browser.test.ts` (`grep -l puppeteer tests/*` lists them). CI runs them all.
- `doc-lint` warnings (stale docs) pass. Errors fail.

## Evidence

Paste into the PR body: the exact command, the `:::` gate lines, the `VERIFY` line, and the red and green output for new tests. Say which gates SKIPped and why.

## Cleanup

`build` writes `dist/` and `public/claude-extension/doop.mcpb` (both gitignored). Leave them or `trash` them; they are not evidence. Stop any `bun run dev` you started by its PID.
