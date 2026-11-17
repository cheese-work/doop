# C00 deploy (CD slice B, CHE-4585)

`image.yml` deploys the digest it just built to C00 when `gate` allows it. Build stays on GitHub
runners. C00 only pulls and runs.

```
push to cheese/main -> ci -> image (digest) -> gate -> deploy [cheese-c00-deploy runner]
                                                         apply -> readback -> (on failure) rollback
```

## Who may deploy

`gate` (`scripts/deploy-gate.mjs`) reads who merged the commit through the pull request API.

- Allowed: `congvc-dev` plus the logins in repo variable `C00_DEPLOY_AUTHORIZERS` (comma-separated;
  put the CHE-3123 agent-merge identity there). Case is ignored; blanks are dropped.
- Any other merger, a direct push, or an unmatched pull request: the image is built, the deploy is skipped.
- A GitHub API error fails the gate job, so nothing deploys.
- `workflow_dispatch` is allowed for the same logins and only from `cheese/main`; any other actor fails.
- `MAIN_RED_PAUSED` (repo variable): any non-empty value skips merge-triggered deploys. A dispatch ignores it.
- After a failed deploy, merge-triggered deploys stay off until a deploy job succeeds (an allowlisted
  dispatch). Skipped and cancelled runs are ignored. If the last 100 runs hold no deploy, it stays off.
- The history is read in the order deploys finished, not the order GitHub lists the runs (creation). A slow
  older run can fail after a newer run succeeded; the failure is the later event, so it suspends. Every
  finished deploy in the runs read counts, each attempt of a rerun too, and the latest finish decides. A
  failure and a success that finish at the same instant count as the failure. A deploy still running says
  nothing yet. A finished deploy with no completion time fails the gate.
- The run list is by creation, and a run created earlier can finish later. So the gate reads 100 runs a page and
  keeps paging until the newest lifting success is more than 24 hours newer than the oldest run on the page
  (a run that old cannot finish after it), or a page is short. It reads at most 10 pages. If that does not
  decide, or a run has no creation time, the last result is unknown and it stays off.
- A rerun is not a recovery. A rerun keeps its run id, so the gate reads the earlier attempts too: an earlier
  failed deploy attempt keeps counting as a failure, for this run and for older runs, unless the login that
  started the rerun (`github.triggering_actor`) is on the allowlist. A rerun of a `workflow_dispatch` run is
  judged by whoever reran it, not by the original dispatcher.
- The deploy job asks again once it holds the deploy lock (`deploy-gate.mjs recheck`), before login or apply,
  on every attempt. GitHub reuses a passed `gate` when failed jobs are rerun, so the recheck is the check that
  sees the rerun. A dispatch passes only if the login that started this attempt (`github.triggering_actor`)
  is on the allowlist; `decide` and `recheck` use the same rule. A push stops there if a deploy ahead of it
  failed. Any other event is refused. A refusal fails the job, so the suspension holds, and nothing has
  touched C00.
- Rebase and merge-queue merges whose commit differs from the pull request's `merge_commit_sha`
  are not matched and deploy by dispatch only.

## What the deploy does (`c00.sh`)

1. `apply`: tags the running image `doop-rollback:previous`, pulls `ghcr.io/cheese-work/doop@sha256:...`,
   starts it with `compose.image.yml` (`--no-build --pull never`). A ref that is not a 64-hex digest is refused.
2. `readback`: the running image has the evidence digest; its `org.opencontainers.image.revision`
   label equals the deployed SHA; the container reports `healthy` on 3 consecutive checks inside
   15 minutes. `unhealthy` or a stopped container fails at once.
3. `rollback` (only on failure, and only if `apply` got as far as starting the change; a login, recheck
   or pull failure leaves the running service alone): starts `doop-rollback:previous` and waits up to 5 minutes for `healthy`.
   The job stays failed, which suspends auto-deploy. On a first deploy there is nothing to roll back to.

## Prerequisites (set once; not in this repo)

| Where         | Name                      | Value                                                                                                                                                                                                                                    |
| ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner        | label `cheese-c00-deploy` | self-hosted runner on C00 with Docker and `docker compose` (node 22 comes from `actions/setup-node`; the runner needs egress to download it), in runner group `c00-deploy` (D1), limited to `cheese-work/doop` and `cheese-work/multica` |
| Repo variable | `C00_DOOP_COMPOSE_DIR`    | optional; default `/home/congvc/.local/share/doop` (`compose.yaml`, service `app`, its `.env`)                                                                                                                                           |
| Repo variable | `C00_DEPLOY_AUTHORIZERS`  | extra logins, e.g. the agent-merge identity                                                                                                                                                                                              |
| Repo variable | `MAIN_RED_PAUSED`         | empty, or a reason to pause                                                                                                                                                                                                              |

Optional on the runner: `C00_COMPOSE_FILE` (default `compose.yaml`), `C00_CONTAINER` (default `doop`).
The compose service is `app` (container name `doop`); `compose.image.yml` overrides only its image.
`C00_DEPLOY_AUTHORIZERS` stays unset until the agent-merge identity is live (CHE-3123); only `congvc-dev` deploys until then.

Rollback-by-digest has not been drilled yet (slice C). Until then the first live deploy needs Cheese's go-ahead.

## Migration gate (CHE-5474 S4a)

Pure checks the deploy train calls before it changes C00; none runs yet (the train switch is off). Rules C-8.1 to C-8.4, C-8.5a, C-8.6.

- `scripts/migration-inventory.mjs`: sha of the ordered `server/db/migrations/*.sql` (name, bytes) and `meta/_journal.json`.
- `scripts/migration-gate.mjs`: `checkAncestry` (candidate is a strict descendant of the C00 revision label), `checkImmutable` (every C00 ledger hash resolves to exactly one predecessor migration and the candidate keeps that name and bytes and its journal entry; new entries are newer than the ledger) and `decide` (ancestry or immutability failure stops the run; not additive, insufficient or not exactly one classifier result per new migration is forward-only).
- `scripts/migration-classify.mjs`: Postgres parser (`libpg-query`); additive is `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` (nullable or constant default), `CREATE INDEX IF NOT EXISTS` (not unique, not concurrent). Anything else fails.
- `scripts/migration-snapshot.mjs`: static drizzle-snapshot diff (new tables, new nullable or constant-default columns, new non-unique indexes only).
- `tests/migrationSnapshots.test.ts`: every journal entry needs `meta/<idx>_snapshot.json`; run `npx drizzle-kit generate` and keep the snapshot with the migration.

## Compat sandbox and smoke suite (CHE-5474 S4c)

Nothing runs yet: the train switch is off and no workflow calls these. Rules C-8.5b to C-8.5d.

- `scripts/compat-sandbox.mjs`: `runCompat` clones the live database into an `--internal` Docker network (`pg_dump | pg_restore`, no pull, no build, no published port, no mount) and runs the candidate migration on the clone under a 120 s external timeout (C-8.8). A failed or timed-out migration is killed by name, then quiescence is proven: container exited, zero sessions with the run's `application_name`, advisory lock `(1685025648, 1)` free (one `pg_terminate_backend` retry); otherwise the reason says `needs_operator`. The proof is in the evidence on success too. It then probes isolation and a failed probe blocks startup: TCP to `1.1.1.1:443`, the default bridge gateway and the live Postgres, DNS for `api.github.com`, the sandbox network's own gateway on ports 22, 53, 80, 443, 2375 and 5432, and a listener the host opens on every interface for the run. The clone database on the sandbox is the positive control: a probe that cannot reach it fails closed. `--internal` alone leaves the bridge gateway address on the host, and a host service bound to it is reachable from the sandbox (observed on Docker 29.6.2), so the network is created with `-o com.docker.network.bridge.inhibit_ipv4=true` (no gateway address at all) and every sandbox container gets an explicit `--ip`, because Docker gives the first free address, the would-be gateway, to the first container that has none. `checkNetworkInspect` refuses a network that has a gateway or a container on that address. The predecessor boots with the seven-key env in `scripts/compat-env.mjs`, then the smoke suite runs from the candidate image. It writes `compat-evidence.json` (candidate SHA, predecessor digest, ledger hash, static / clone / behavior results, `df` before and after). `verifyEvidence` (CLI `verify`) is deploy step 1: evidence for another predecessor digest, ledger hash or candidate SHA is refused.
- `scripts/deploy-smoke.mjs` + `deploy/cd/smoke-routes.json`: an ordered chain of calls per route group against a booted server, as a throwaway user. `write` calls are real operations (create a canvas, rename it, create a frame, comment, agent key, automation, workspace; set notification and local-agent settings; delete an integration) and a later `read` checks the value came back (`expectJson`, values captured with `save`). `contract` calls name the outside service that makes success impossible in the sandbox (Stripe, APNs, a worker token, no egress) and the status that proves the route is up. A group with no write carries a `noWrite` reason. `tests/compatSmoke.test.ts` fails CI when a route group in `server/` has no entry (or an entry has no route), when a placeholder 404 stands in for a write, and when a broken real operation does not fail the suite.
- `c00.sh sweep`: removes every `doop.compat.run` container, network and volume, reads back zero, prints `df` before and after. Every C00 compat job runs it first and last; a failed sweep fails the job.
- To add a production key to the predecessor env you must edit `ALLOWED_KEYS` and `tests/compatSandbox.test.ts`; CI fails if a key from `server/env.ts` outside the seven is added.
- `tests/compatIsolationDocker.test.ts` runs the same probe script on a real internal network (needs Docker; skips without it).
