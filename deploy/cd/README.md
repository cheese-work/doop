# C00 deploy (deploy train S2, CHE-5544; plan CHE-5474)

Two workflows. D1 (`image.yml`) tests, builds, pushes and records a candidate manifest; it holds no
deploy secret and no C00 runner. D2 (`cd-deploy.yml`) is the only workflow that touches C00. Build stays
on GitHub runners; C00 only pulls and runs.

```
D1  push to cheese/main -> ci -> image (digest) -> candidate-manifest artifact
                                                  (SHA, digest, migration inventory sha, D1 run id)
D2  schedule 06:17 / 14:17 / 22:17 ICT, or dispatch
    resolve [hosted] -> admit [hosted] -> deploy [C00] -> readback-confirm [C00]
                                                       \-> rollback [C00] (failure only)
```

## The switch is off

The train deploys only when repo variable `DOOP_DEPLOY_TRAIN` is `on`. Absent, empty or anything else:
a scheduled run ends at `resolve` as a clean skip (exit 0, `go=false`). A variable that cannot be read is
a skip too. This slice approves no deploy. Arming, restoring and lifting the suspension marker
`DOOP_DEPLOY_SUSPENDED` (`clear:*`, `armed:*`, `suspended:*`) are slice S3a: until it lands no marker reads
`clear:*`, so a train run always skips.

## Entry rules (`deploy-gate.mjs decide`)

- `schedule`: mode `train`. `workflow_dispatch` takes `mode` (`train`, `recovery`, `drill`).
- A train run is attempt 1 only; a rerun is refused. A train dispatch is allowed only as the schedule
  backup (`schedule_backup=true` from `github-actions[bot]`).
- `recovery` and `drill` are dispatch-only, by `congvc-dev` or a login in `C00_DEPLOY_AUTHORIZERS`, never by a
  bot. `drill` is refused until slice S6.
- `MAIN_RED_PAUSED` set skips a train run. A skip is a clean exit; a refusal fails the job.

## Candidate and pin (`resolve`, `admit`)

`resolve` picks the newest `cheese/main` commit with a successful D1 push run (train), or takes
`candidate_sha` (recovery, drill), and reads that run's `candidate-manifest`. `admit` stops the run
unless all four name the candidate: the manifest SHA, the D1 run (success, on that exact SHA), the image
label `org.opencontainers.image.revision`, and the migration inventory sha recomputed from the checked-out
candidate (`scripts/migration-inventory.mjs`). A red D1 run skips a train run and refuses recovery.

## Checks per operation (`deploy-gate.mjs recheck <mode> --op ... --expect ...`)

| Operation   | Where                                           | Passes when                                                                        |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pre-arm`   | `deploy` step 1                                 | switch, pause and marker allow it; the candidate is strictly ahead of C00          |
| `pre-apply` | `c00.sh apply`, inside `flock`, before `docker` | the same facts, and the marker is this run's own `--expect` value                  |
| `confirm`   | `readback-confirm`                              | marker is this run's own value; C00 runs the candidate digest and label            |
| `rollback`  | `rollback`, before any change                   | marker is this run's own value; reports `action`: `rollback`, `none`, `superseded` |

Before the arm write a "no" is a skip; after it every "no" fails the job. Migration quiescence is an
injected hook; slice S4b wires the real proof. An unknown operation exits non-zero.

## Locks

`c00.sh apply` takes `flock -w 600 /var/lock/doop-deploy.lock` (`C00_LOCK_FILE`, `C00_LOCK_WAIT`), runs the
`pre-apply` check, then tags the rollback target, pulls and starts. Every C00 job also sits in GitHub
concurrency group `c00-deploy-doop` with `cancel-in-progress: false`. D2 has no workflow-level concurrency.

## What the deploy does (`c00.sh`)

1. `apply`: lock, `pre-apply` check, tags the running image `doop-rollback:previous`, pulls
   `ghcr.io/cheese-work/doop@sha256:...`, starts it with `compose.image.yml` (`--no-build --pull never`). A ref
   that is not a 64-hex digest is refused; so is a missing `DEPLOY_MODE` or `MARKER_EXPECT`.
2. `readback`: the running image has the manifest digest; its `org.opencontainers.image.revision` label equals
   the deployed SHA; the container reports `healthy` on 3 consecutive checks inside 15 minutes.
3. `rollback` (only when `apply` got as far as starting the change, and only when the rollback check says the
   candidate still runs): starts `doop-rollback:previous` and waits up to 5 minutes for `healthy`.

## Legacy gate

`decide` and `recheck` in `deploy-gate.mjs` (the retired `image.yml` gate with its run-history walk) stay
exported and tested until S3a replaces them with the marker.

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
