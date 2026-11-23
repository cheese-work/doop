# C00 deploy (deploy train S2 and S3a, CHE-5544, CHE-5545; plan CHE-5474)

Two workflows. D1 (`image.yml`) tests, builds, pushes and records a candidate manifest; it holds no
deploy secret and no C00 runner. D2 (`cd-deploy.yml`) is the only workflow that touches C00. Build stays
on GitHub runners; C00 only pulls and runs.

```
D1  push to cheese/main -> ci -> image (digest) -> candidate-manifest artifact
                                                  (SHA, digest, migration inventory sha, D1 run id)
D2  schedule 06:17 / 14:17 / 22:17 ICT, or dispatch
    resolve [hosted] -> admit [hosted] -> deploy [C00]: pre-arm check, ARM, apply, readback
                                       -> readback-confirm [C00]: confirm check, RESTORE (train only)
                                       \-> rollback [C00] (failure only): check, roll back, SUSPEND
```

## The switch is off

The train deploys only when repo variable `DOOP_DEPLOY_TRAIN` is `on`. Absent, empty or anything else:
a scheduled run ends at `resolve` as a clean skip (exit 0, `go=false`). A variable that cannot be read is
a skip too. This slice approves no deploy: nothing sets the switch to `on`, and the marker below starts absent.

## The suspension marker (S3a, C-10)

Repo variable `DOOP_DEPLOY_SUSPENDED` is the one thing that lets a train run. Its value is one of:

| Value                                       | Meaning                                       |
| ------------------------------------------- | --------------------------------------------- |
| `clear:<nonce>:<lift run id or restore>`    | the train may run                             |
| `armed:<nonce>:<run id>:<sha>`              | a train run is changing C00                   |
| `suspended:<nonce>:<run id>:<sha>:<reason>` | stopped until a lift (slice S3b) writes clear |

The nonce is 128 random bits. Absent, unreadable or any other shape reads as suspended; a prefix match is not
enough. `scripts/deploy-marker.mjs` is the only writer. Every write reads the variable, checks it is the
value the writer expects, writes, and reads it back; a write it cannot prove fails the job.

- **Arm before change.** A train run writes `armed:*` over `clear:*` right after the `pre-arm` check and before
  `docker login`, any pull or any start. If that write fails, nothing on C00 has changed and the marker still
  reads as it did.
- **Restore only by the same run.** Only the passing `confirm` of that run writes a new `clear:*:restore`, and
  only over its own `armed:*`. Any other value (another run, a suspension, a lift) refuses and fails the job.
  A failed restore leaves `armed:*`, which is suspended.
- **Recovery and drill never write clear.** They write `suspended:*` over whatever stands, before any change,
  and never touch `DOOP_DEPLOY_TRAIN`. A bot dispatch is refused at entry. A rollback also writes `suspended:*`,
  over its own `armed:*`, whatever the rollback itself did.
- **Reading is read only.** `decide` and every check read the marker and never write it.
- **Where the reads come from (CHE-9181).** `github.token` cannot be granted the Variables permission, so the REST
  read of a variable fails with 403. `resolve/decide` therefore takes `DOOP_DEPLOY_TRAIN`, `MAIN_RED_PAUSED` and
  `DOOP_DEPLOY_SUSPENDED` from env (`${{ vars.X }}`; unset reads as empty, i.e. absent). The C00 checks
  (`pre-arm`, `pre-apply`, `confirm`) read them through the API with the marker App token (`VARS_TOKEN`), minted
  before the check. The `rollback` job mints it too, but a failed mint does not stop the rollback: the check and the
  rollback run after it, and without a token the check decides from what C00 runs alone. A variable that cannot be read **fails the run red**
  with its HTTP status and message; it is never a skip.

Every failure leaves the marker `armed` or `suspended`, so the train stops until a lift. Lifting is S3b.

### Adoption of the 11 Nov failure (one write, by an admin)

The variable starts absent, which reads as suspended. Before this slice's PR merges, write the marker once so
the failed deploy of 11 Nov is recorded as the reason. The App token and the admin both can:

```bash
node scripts/deploy-marker.mjs suspend --any --reason migrated   # env: GH_TOKEN (App or admin), REPO=cheese-work/doop, RUN_ID=42955625332, SHA=612f86854a6020f45b90321302a79dae1214d13a
```

The agent that wrote S3a holds no token that can write repo variables, so this write is an owner action.

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

## Prerequisites (set once; not in this repo)

| Where         | Name                      | Value                                                                                                                                                                                                                                    |
| ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner        | label `cheese-c00-deploy` | self-hosted runner on C00 with Docker and `docker compose` (node 22 comes from `actions/setup-node`; the runner needs egress to download it), in runner group `c00-deploy` (D1), limited to `cheese-work/doop` and `cheese-work/multica` |
| Repo variable | `C00_DOOP_COMPOSE_DIR`    | optional; default `/home/congvc/.local/share/doop` (`compose.yaml`, service `app`, its `.env`)                                                                                                                                           |
| Repo variable | `C00_DEPLOY_AUTHORIZERS`  | extra logins, e.g. the agent-merge identity                                                                                                                                                                                              |
| Repo variable | `MAIN_RED_PAUSED`         | empty, or a reason to pause                                                                                                                                                                                                              |
| Environment   | `doop-deploy-marker`      | on `cheese-work/doop`; holds the marker App's key. The three C00 jobs run in it; no hosted job does                                                                                                                                      |
| Env variable  | `DOOP_MARKER_APP_ID`      | App id of the marker GitHub App (repository permission: Variables read and write; installed on `doop` only)                                                                                                                              |
| Env secret    | `DOOP_MARKER_APP_KEY`     | that App's private key                                                                                                                                                                                                                   |

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

## Supervised migration apply (CHE-5474 S4b)

Rules C-8.7 and C-8.8. With `DOOP_DEPLOY_TRAIN=on`, `c00.sh apply` no longer lets the app migrate at boot.

**Switch.** Everything below runs only when the deploy job's `DOOP_DEPLOY_TRAIN` (repository variable, passed by `image.yml`) is exactly `on`. Absent, `off` or any other value: `apply` and `rollback` do what they did before the train (no quiescence read, no one-shot container, the app migrates at boot and is not given `compose.supervised.yml`), and `DEPLOY_RUN_ID` and a Postgres container are not needed. The overlay that sets `DOOP_SKIP_MIGRATIONS=1` is `compose.supervised.yml`, added to the compose command only in train mode; `compose.image.yml` is unchanged.

- `apply` first proves quiescence, then pulls, then runs `node server/db/migrate.ts` once in a one-shot container `doop-migrate-<DEPLOY_RUN_ID>` of the candidate image (`docker compose run`, label `doop.migrate.run`). The runner sets `application_name=doop-migrate-<run id>`, holds `pg_advisory_lock(1685025648, 1)` for the whole run, and fails at 120 s (`C00_MIGRATE_SECONDS`). The app is then recreated with `DOOP_SKIP_MIGRATIONS=1` (`compose.supervised.yml`).
- Timeout or non-zero exit: no app start. `docker kill`, `docker wait`, `pg_terminate_backend` on every session with that name, then within 30 s (`C00_QUIESCE_SECONDS`) the container is `exited`, `pg_stat_activity` has no such session (`(pid, backend_start)` logged before and after) and `pg_locks` shows the key free. The ledger is compared with the pre-apply ledger (`ledger_changed=`). Proven: outcome `migrate_failed`, the running app is untouched. Not proven: outcome `needs_operator`. Both go to `$GITHUB_OUTPUT` as `outcome=`.
- `apply`, `rollback` and `quiescence` (for the compat and lift jobs) first check the same facts: no migrate container running, no session named `doop-migrate-%`, advisory key free. Any read that fails counts as not proven and refuses with `needs_operator`.
- All database reads go through `docker exec` into `C00_PG_CONTAINER` (local socket, `default_transaction_read_only=on`); the only write is `pg_terminate_backend`, and only on the failed run's own name.
- `image.yml` passes `DOOP_DEPLOY_TRAIN`, `DEPLOY_RUN_ID` (`<run id>-<attempt>`) and optional repo variable `C00_DOOP_PG_CONTAINER`; empty, `c00.sh` finds the compose project's `db` service (`docker compose ps -q db`) and refuses if there is none. `tests/c00Migrate.test.ts` runs `c00.sh` with the deploy job's real env.
- Not in this slice: the marker write on `migrate_failed`, the compat sandbox (S4c) and rollback sequencing (S5). The switch stays off.
