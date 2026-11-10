---
name: verify-doop
description: Use when you must see a doop change working in the real app, not only in tests. Launches an isolated production server on X99, drives one feature in a real browser, saves screenshots and a step log, and cleans up. Not for gates (typecheck, lint, vitest); use verify-change for those.
---

<!-- Idea from pstack's create-verification-skill / maintain-verification-skill (Lauren Tan, MIT; https://github.com/cursor/plugins at de8ee15dd1194627d21eb5fcd41cb1873208dabb). Written fresh for doop, no text copied. -->

# Verify doop in the live app

Run on X99. Never build or launch on C00. Needs `bun run build` done (`dist/`), `/usr/bin/google-chrome` (override with `CHROME_PATH`; set `CHROME_NO_SANDBOX=1` when the sandbox is not allowed).

Pick a feature from `features/README.md` first. Then run these five steps in order.

## Launch

```bash
RUN=$(.claude/skills/verify-doop/scripts/launch.sh)   # prints the run dir; ready = /healthz ok
```

- `.claude/skills/verify-doop/scripts/launch.sh` starts `server/index.ts` in production mode on a free port.
- The run dir is the server's cwd, so the pglite database starts empty. It holds `pid`, `port`, `server.log`.
- Exit 3 = no `dist/`. Exit 4 = server did not come up; read `$RUN/server.log`.

## Doctor

```bash
.claude/skills/verify-doop/scripts/doctor.sh "$RUN"
```

- `.claude/skills/verify-doop/scripts/doctor.sh` is read-only. It checks the pid owns the run dir, `/healthz`, `dist/`, the browser and the isolated database.
- Do not drive if any line says FAIL.

## Drive

```bash
EV=<evidence dir outside $RUN>
node .claude/skills/verify-doop/scripts/drive.mjs "$RUN" pages "$EV"
```

- `.claude/skills/verify-doop/scripts/drive.mjs` takes `auth`, `canvas` or `pages`. Each one signs up a fresh user through the auth API, then drives the UI by real selectors.
- A new feature: add `features/<name>.md` and a function in `drive.mjs`. Do not hand-drive ad hoc.

## Evidence

- Evidence = the screenshots and `<feature>.json` that `drive.mjs` writes into `$EV`, plus the console PASS/FAIL lines.
- Every claim needs the action and the resulting state. "Page added" = screenshot of the row plus the count before and after, and the count after a reload.
- Keep `$EV` outside `$RUN`. Attach the files to the issue or PR. Never put real credentials in a screenshot.

## Cleanup

```bash
.claude/skills/verify-doop/scripts/cleanup.sh "$RUN"
```

- `.claude/skills/verify-doop/scripts/cleanup.sh` kills only the pid whose cwd is `$RUN`, then deletes `$RUN`. Any other pid: exit 1, nothing touched.
- Never `pkill node` or kill by name.
- After cleanup, confirm `$EV` still has the files and `curl localhost:<port>/healthz` fails.

## Maintain

Drive a feature after a change that touches it. If a selector moved, fix `drive.mjs` and the feature file in the same PR. A feature file that has not been driven in a run is a draft.
