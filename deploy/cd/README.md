# C00 deploy (deploy train S2 and S3a, CHE-5544, CHE-5545; plan CHE-5474)

Two workflows. D1 (`image.yml`) tests, builds, pushes and records a candidate manifest; it holds no
deploy secret and no C00 runner. D2 (`cd-deploy.yml`) is the only workflow that touches C00. Build stays
on GitHub runners; C00 only pulls and runs.

```
D1  push to cheese/main -> ci -> image (digest) -> candidate-manifest artifact
                                                  (SHA, digest, migration inventory sha, D1 run id)
D2  schedule 06:17 / 14:17 / 22:17 ICT, or dispatch
    resolve [hosted] -> admit [hosted] -> deploy [C00]: pre-arm check, ARM, apply, readback (T0)
                                       -> readback-delay [hosted, environment c00-readback-delay, 15 min timer]
                                       -> readback-confirm [C00]: c00.sh confirm (lock, quiescence, confirm check), RESTORE (train only)
                                       \-> rollback [C00] (failure only): c00.sh rollback (lock, quiescence, rollback check, roll back, read back), SUSPEND, fail
    evidence [hosted, every run]: deploy-evidence.json artifact and run summary
```

## The switch is off

The train deploys only when repo variable `DOOP_DEPLOY_TRAIN` is `on`. Absent, empty or anything else:
a scheduled run ends at `resolve` as a clean skip (exit 0, `go=false`). A variable that cannot be read is
a skip too. This slice approves no deploy: nothing sets the switch to `on`, and the marker below starts absent.

## The suspension marker (S3a, C-10)

One file on the C00 host is the one thing that lets a train run (CHE-9877; it was the repo variable
`DOOP_DEPLOY_SUSPENDED`, written through a GitHub App token, until then). It is `$C00_MARKER_FILE`, default
`$C00_STATE_DIR/deploy-marker` with `C00_STATE_DIR` defaulting to `/var/lib/doop-deploy`, mode 0600, one line. Its
value is one of:

| Value                                       | Meaning                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| `clear:<nonce>:<lift run id or restore>`    | the train may run                                           |
| `armed:<nonce>:<run id>:<sha>`              | a train run is changing C00                                 |
| `suspended:<nonce>:<run id>:<sha>:<reason>` | stopped until the audited lift (`cd-lift.yml`) writes clear |

The nonce is 128 random bits. Absent, unreadable or any other shape reads as suspended; a prefix match is not
enough. `scripts/deploy-marker.mjs` is the only writer, and only the C00 jobs run it. Every write reads the
file, checks it is the value the writer expects, writes a temp file and renames it over the marker, and reads it
back; a write it cannot prove fails the job. No GitHub App, PAT, environment secret or repo variable takes part.
A missing file reads as suspended, so a host starts stopped: the first value is a recovery run's `suspended:*`
(`suspend --any`), and an approved lift clears it. The directory and its owner (the runner's user) are set by hand
on C00, once; no job creates it.

- **Arm before change.** A train run writes `armed:*` over `clear:*` right after the `pre-arm` check and before
  `docker login`, any pull or any start. If that write fails, nothing on C00 has changed and the marker still
  reads as it did.
- **Restore only by the same run.** Only the passing `confirm` of that run writes a new `clear:*:restore`, and
  only over its own `armed:*`. Any other value (another run, a suspension, a lift) refuses and fails the job.
  A failed restore leaves `armed:*`, which is suspended.
- **Recovery and drill never write clear.** They write `suspended:*` over whatever stands, before any change,
  and never touch `DOOP_DEPLOY_TRAIN`. A bot dispatch is refused at entry. A rollback also writes `suspended:*`,
  over its own `armed:*`, whatever the rollback itself did.
- **Reading is read only.** Every check reads the marker and never writes it. The hosted `resolve/decide` cannot
  see the host file, so it no longer reads the marker: the train's marker-clear check is the `pre-arm` check on
  C00, which skips the run when the marker is not `clear:*`. Before this change `decide` skipped it earlier, on
  the hosted runner.
- **Where the reads come from.** `github.token` cannot be granted the Variables permission, so the REST read of a
  variable fails with 403 (CHE-9181). Every job therefore takes `DOOP_DEPLOY_TRAIN` and `MAIN_RED_PAUSED` from
  env (`${{ vars.X }}`; unset reads as empty, i.e. absent). On C00 the value is fixed when the job starts, so a
  switch or pause changed while a deploy runs is seen by the next run, not the running one. The marker is read
  from the host file, every time, under the same checks. A marker that cannot be read **fails the check closed**
  (a refusal naming the cause, never a skip), in `rollback` too: there is no token path left that could decide
  without it.

Every failure leaves the marker `armed` or `suspended`, so the train stops until a lift. Lifting is `cd-lift.yml` (below).

### The audited lift (`cd-lift.yml`, S3b, C-10.6 and C-10.7)

The only way from `armed:*` or `suspended:*` back to `clear:*`. Dispatch only, one input: `decision_id`, the id of
a Multica decision. No step is a human-typed command.

1. The dispatcher and the triggering login must both be in repo variable `DOOP_LIFT_DISPATCHERS` (checked first,
   before any secret is read). The job runs only on `cheese/main`, in environment `doop-lift`, on the C00 runner,
   in concurrency group `c00-deploy-doop`, and `c00.sh lift` takes the host lock. It holds no GitHub App or token:
   the lift writes the host marker file directly.
2. Under the lock it refuses unless **all** hold, and a refusal leaves the marker as it was:
   - the decision is action `doop.deploy_lift` v1, `approved`, by `vars.DOOP_LIFT_APPROVER_ID` (Cheese), not
     withdrawn, rejected, revoked or expired; unreadable or unknown is a refusal;
   - its `marker_value` equals the marker that stands now, byte for byte, and its `repo` is `cheese-work/doop`;
   - migration quiescence is proven (C-8.8), `/healthz` answers 200, and the running digest and revision label read;
   - the decision and the marker are read again immediately before the write and still hold (a marker that
     changed, or a decision revoked, during the lift refuses).
3. It writes `clear:<nonce>:<lift run id>`, reads it back, and records lifter, decision id, approver, health, digest,
   revision and ICT times in the run summary and the `lift-evidence` artifact (`lift-evidence.json`, outcome
   `lifted`, `refused` or `failed`; `failed` means the write could not be read back, so check the marker file on C00 by hand).
   Two lifts at once serialize on the lock; the second finds the marker changed and is refused.

The lift never reads or writes `DOOP_DEPLOY_TRAIN`: the train stays off until Cheese turns it on.

| Where         | Name                                               | Value                                                                                  |
| ------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Environment   | `doop-lift`                                        | holds the secrets below; restrict deployment branches to `cheese/main`                 |
| Env secret    | `DOOP_LIFT_DECISION_READ_TOKEN`                    | read-only token for `GET /api/decisions/{id}/state`                                    |
| Env secret    | `DOOP_LIFT_MULTICA_SERVER_URL`, `..._WORKSPACE_ID` | the Multica server (tailnet only, so the C00 runner must reach it) and its workspace   |
| Repo variable | `DOOP_LIFT_DISPATCHERS`                            | logins that may dispatch a lift                                                        |
| Repo variable | `DOOP_LIFT_APPROVER_ID`                            | Cheese's Multica member id; the decision's approver must equal it                      |
| Repo variable | `C00_DOOP_HEALTHZ_URL`                             | optional; default `http://127.0.0.1:4400/healthz` (what the app answers on C00 itself) |

### First value on a host with no marker file

The file starts absent, which reads as suspended, and nothing creates its directory. Once the directory exists
(owner action, once, on C00), the first value comes from a recovery run: `suspend --any` writes `suspended:*` over
the absent marker, and `cd-lift.yml` clears it. For a by-hand write on C00 as the runner's user:

```bash
C00_STATE_DIR=/var/lib/doop-deploy RUN_ID=<run id> SHA=<40 hex> node scripts/deploy-marker.mjs suspend --any --reason migrated
```

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

| Operation   | Where                                                                  | Passes when                                                                        |
| ----------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pre-arm`   | `deploy` step 1                                                        | switch, pause and marker allow it; the candidate is strictly ahead of C00          |
| `pre-apply` | `c00.sh apply`, inside `flock`, before `docker`                        | the same facts, and the marker is this run's own `--expect` value                  |
| `confirm`   | `c00.sh confirm`, inside `flock`, after quiescence                     | marker is this run's own value; C00 runs the candidate digest and label            |
| `rollback`  | `c00.sh rollback`, inside `flock`, after quiescence, before any change | marker is this run's own value; reports `action`: `rollback`, `none`, `superseded` |

Before the arm write a "no" is a skip; after it every "no" fails the job. Every operation proves migration
quiescence first: the gate runs `c00.sh quiescence` (no migrate container running, no `doop-migrate-%` session,
advisory key free; a read that fails, a hang or a missing script counts as not proven). An unknown operation exits
non-zero. `confirm` and `rollback` are decided by `c00.sh` after it holds the lock, never in a workflow step before
it: a deployment or a marker change that lands while the job waits for the lock is seen, and a `superseded`
rollback changes nothing.

## Locks

`c00.sh apply`, `confirm` and `rollback` take `flock -w 600 /var/lock/doop-deploy.lock` (`C00_LOCK_FILE`,
`C00_LOCK_WAIT`) and run their check under it. `apply` runs the `pre-apply` check, then tags the rollback target,
pulls and starts. Every C00 job also sits in GitHub
concurrency group `c00-deploy-doop` with `cancel-in-progress: false`. D2 has no workflow-level concurrency.

## What the deploy does (`c00.sh`)

1. `apply`: lock, `pre-apply` check, tags the running image `doop-rollback:previous`, pulls
   `ghcr.io/cheese-work/doop@sha256:...`, starts it with `compose.image.yml` (`--no-build --pull never`). A ref
   that is not a 64-hex digest is refused; so is a missing `DEPLOY_MODE` or `MARKER_EXPECT`.
2. `readback`: the running image has the manifest digest; its `org.opencontainers.image.revision` label equals
   the deployed SHA; the container reports `healthy` on 3 consecutive checks inside 90 s (`C00_READBACK_SECONDS`).
   It writes T0 to `$GITHUB_OUTPUT`: `restart_count`, `health`, `t0_epoch`. `apply` writes `lock_wait_seconds`.
3. `readback-delay` (S5, C-9): a hosted job in environment `c00-readback-delay`, whose 15 min wait timer is the
   delay. It holds no runner and no lock while it waits.
4. `confirm` (job `readback-confirm`): under `flock`, migration quiescence holds (switch on or off), the `confirm`
   check passes, the container restart count is still the T0 count, it is `healthy`, and it still runs the candidate digest and label. It also refuses when
   fewer than `C00_CONFIRM_MIN_SECONDS` (900) have passed since T0, so a missing wait timer fails closed. A train
   run then restores the marker.
5. `rollback` (only when `apply` got as far as starting the change, after a failure in `deploy`, `readback-delay`
   or `readback-confirm`): `c00.sh rollback` takes `flock`, proves migration quiescence (switch on or off), then the
   `rollback` check decides from what C00 runs and what the marker says at that moment.
   - The candidate digest: `c00.sh rollback` first checks the retained `doop-rollback:previous`
     image is the predecessor digest, starts it, waits up to 5 minutes for `healthy`, then reads back the
     predecessor digest, label and health.
   - The predecessor digest: no container change. Any other digest (a newer deploy replaced the candidate): no
     container change, outcome `superseded`.
     In every case the job then writes `suspended:*` over this run's `armed:*` and ends red. A rollback that cannot
     write the marker leaves `armed:*`, which also reads as suspended.

## Evidence (S5, C-12)

The `evidence` job runs on every D2 run, hosted and read only. It writes `deploy-evidence.json` (artifact
`deploy-evidence`) and appends the same table to the run summary: outcome, candidate SHA, digest, predecessor,
health, restart counts, delay, lock wait, and the read-back time, confirm time and write time in ICT with UTC
beside it. Values that are not the exact shape they should be are dropped. Tofu or c00-hermes-devops copies the
read-back values to CHE-2752.

## Watchers (S7, C-7)

Two scheduled workflows watch D2. Both do nothing (a clean skip, exit 0) while `DOOP_DEPLOY_TRAIN` is not `on`, so
they cost no alarm while the train is off, and both are scheduled from the merge of this slice, so they are seen
running before the switch can turn on. The last successful D2 SHA has four states, never a guess:
`known` (a SHA), `pending` (a D2 run under 3 h old is unfinished and may confirm any minute: only the SHA comparison waits: freshness still alarms at 90 min after the slot and live still needs a healthy `/healthz`), `none` (a proven first deployment: no D2 run exists, or every one was read and none confirmed) and
`unknown` (the history cannot be read). Where it comes from, in order:

1. The deployment record. The `evidence` job of D2 (`permissions: deployments: write`, after the artifact upload) runs
   `node scripts/cd-watch.mjs record deploy-evidence.json` on a confirmed deploy: a GitHub deployment in environment
   `c00-doop` at the candidate SHA (description `... (D2 run <id>, confirmed <UTC time>)`, `auto_merge` and `production_environment` sent as
   JSON booleans), with a `success` status, read back before the step passes. A write that fails turns the D2 run red.
   Neither artifact expiry nor any number of skipped D2 slots can lose it. The watchers read it with
   `deployments: read`. Deploys are ordered by their confirmation time, never by run ID: runs queue independently, so
   an older run can confirm after a newer one, and a run can be rerun days later. The record is not trusted alone: every
   D2 run whose last activity (`updated_at`, which a rerun moves) is not before the record's confirmation is checked,
   newest created first. A run with no evidence (green, failed or cancelled: a deploy can confirm and then lose its
   evidence upload), or whose evidence confirms another SHA after the record (its record write failed), is `unknown`;
   one that confirmed before the record is older and ignored. A run that ended before the record's confirmation is
   not read. A run created over 30 days (GitHub's rerun limit) before the record ends the scan. A confirmed deploy
   without a confirmation time cannot be ordered: the record step fails the D2 run.
2. Without a record: the `deploy-evidence` artifact (`outcome: confirmed`), the latest confirmation winning, up to
   100 evidence reads (a skipped D2 ends green, so a run conclusion is not used). A run whose artifact is gone or
   unreadable, a confirmed artifact with a bad SHA, or hitting the scan limit is `unknown`.

A D2 run whose `deploy` job was skipped never touched C00: with no evidence it is read as a clean skip, not `unknown`
(CHE-9479). A run whose deploy job ran and left no evidence is still `unknown`.
`unknown` fails visibly: the freshness watch alarms at once when a candidate exists, and the live watch fails. A
deployed candidate is never treated as overdue, and an unreachable `/healthz` never passes, because of missing history.
The decisions are pure functions in `scripts/cd-watch.mjs`, tested in `tests/cdWatch.test.ts`.

- `cd-freshness-watch.yml` (hosted, `12,27,42,57 * * * *`): the newest D2 slot is at least 45 min old, a qualified
  candidate (`pickCandidate`: the newest `cheese/main` commit with a successful D1 push run) differs from the last
  successful D2 SHA, and no D2 run was created since the slot: one `workflow_dispatch` of `cd-deploy.yml` with
  `mode=train`, `schedule_backup=true`, made with the workflow token (`github-actions[bot]`, the one actor D2 admits
  for it). Once a D2 run exists there is no second dispatch. At 90 min with a candidate still ahead the run fails with
  `::error::`, whether or not a D2 run exists (a skipped, suspended or forward-only run left C00 behind all the same).
  A failed D1 run on `cheese/main` is rerun once (`gh run rerun --failed` while `run_attempt` is 1).
- `cd-live-revision.yml` (on `cheese-x99-gate`, schedule only, `7,22,37,52 * * * *`): reads
  `https://$DOOP_C00_HOST/healthz` over the tailnet and fails when the revision is behind the last successful D2 SHA.
  Ahead is fine (a deploy whose evidence is not written yet); a diverged, missing, malformed or `unknown` revision
  fails. With a proven `none` (no successful D2 yet) there is no SHA to compare with, but `/healthz` must still answer
  `ok: true` with a 40-hex revision; with `unknown` it fails.
- `/healthz` answers `{ ok, revision }`. `image.yml` passes `DOOP_REVISION=${{ github.sha }}` as a build arg; the
  `Dockerfile` writes it to `/app/REVISION` (last layer) and `server/revision.ts` reads it once at start. A build
  without the arg, or a dev run, reports `unknown`.

Read-back before the switch: before `DOOP_DEPLOY_TRAIN` is set to `on`, each watcher shows a green scheduled run on
the Actions page (`gh run list --workflow cd-freshness-watch.yml --event schedule`, and the same for
`cd-live-revision.yml`) from after the merge of this slice. The live watcher reads the doop host from repo variable
`DOOP_C00_HOST` (host name on C00's tailnet, no scheme, port allowed); when it is unset or blank it uses the default
`c00Host` in `scripts/cd-watch.mjs` (`congvc-c00.taila6fa8a.ts.net:34443`, the doop port on C00). Set the variable only to override it.

## Prerequisites (set once; not in this repo)

| Where         | Name                      | Value                                                                                                                                                                                                                                    |
| ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner        | label `cheese-c00-deploy` | self-hosted runner on C00 with Docker and `docker compose` (node 22 comes from `actions/setup-node`; the runner needs egress to download it), in runner group `c00-deploy` (D1), limited to `cheese-work/doop` and `cheese-work/multica` |
| Repo variable | `C00_DOOP_COMPOSE_DIR`    | optional; default `/home/congvc/.local/share/doop` (`compose.yaml`, service `app`, its `.env`)                                                                                                                                           |
| Repo variable | `C00_DEPLOY_AUTHORIZERS`  | extra logins, e.g. the agent-merge identity                                                                                                                                                                                              |
| Repo variable | `DOOP_C00_HOST`           | optional override; default in `scripts/cd-watch.mjs` `c00Host`; read by `cd-live-revision.yml`                                                                                                                                           |
| Repo variable | `MAIN_RED_PAUSED`         | empty, or a reason to pause                                                                                                                                                                                                              |
| Environment   | `c00-readback-delay`      | on `cheese-work/doop`, with a **15 minute wait timer** and no secret. Created by hand before the C-11 drill: GitHub creates a missing environment with no timer, and `c00.sh confirm` then refuses (delay not honoured)                  |
| Marker dir    | `/var/lib/doop-deploy`    | on C00, owned by the runner's user, mode 0700 (set by hand, once); holds `deploy-marker` and the compat guard. Override with `C00_MARKER_FILE` or `C00_STATE_DIR` in the runner's env                                                    |

Optional on the runner: `C00_COMPOSE_FILE` (default `compose.yaml`), `C00_CONTAINER` (default `doop`).
The compose service is `app` (container name `doop`); `compose.image.yml` overrides only its image.
The gate admits mergers `congvc-dev` and the agent-merge App, whose `merged_by.login` is the exact string `congvc-bot-x99[bot]` (GitHub adds `[bot]` for an App). Logins match exactly; `[bot]` is never stripped, so `other-app[bot]` is skipped.
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

**Switch.** Everything below runs only when the deploy job's `DOOP_DEPLOY_TRAIN` (repository variable, passed by `image.yml`) is exactly `on`. Absent, `off` or any other value: `apply` does what it did before the train (no one-shot container, the app migrates at boot and is not given `compose.supervised.yml`) and `DEPLOY_RUN_ID` is not needed. `confirm` and `rollback` prove quiescence with the switch off too, because the app migrating at boot can still be running, so a Postgres container is needed for them. The overlay that sets `DOOP_SKIP_MIGRATIONS=1` is `compose.supervised.yml`, added to the compose command only in train mode; `compose.image.yml` is unchanged.

- `apply` first proves quiescence, then pulls, then runs `node server/db/migrate.ts` once in a one-shot container `doop-migrate-<DEPLOY_RUN_ID>` of the candidate image (`docker compose run`, label `doop.migrate.run`). The runner sets `application_name=doop-migrate-<run id>`, holds `pg_advisory_lock(1685025648, 1)` for the whole run, and fails at 120 s (`C00_MIGRATE_SECONDS`). The app is then recreated with `DOOP_SKIP_MIGRATIONS=1` (`compose.supervised.yml`).
- Timeout or non-zero exit: no app start. `docker kill`, `docker wait`, `pg_terminate_backend` on every session with that name, then within 30 s (`C00_QUIESCE_SECONDS`) the container is `exited`, `pg_stat_activity` has no such session (`(pid, backend_start)` logged before and after) and `pg_locks` shows the key free. The ledger is compared with the pre-apply ledger (`ledger_changed=`). Proven: outcome `migrate_failed`, the running app is untouched. Not proven: outcome `needs_operator`. Both go to `$GITHUB_OUTPUT` as `outcome=`.
- `apply`, `rollback` and `quiescence` (for the compat and lift jobs) first check the same facts: no migrate container running, no session named `doop-migrate-%`, advisory key free. Any read that fails counts as not proven and refuses with `needs_operator`.
- All database reads go through `docker exec` into `C00_PG_CONTAINER` (local socket, `default_transaction_read_only=on`); the only write is `pg_terminate_backend`, and only on the failed run's own name.
- `image.yml` passes `DOOP_DEPLOY_TRAIN`, `DEPLOY_RUN_ID` (`<run id>-<attempt>`) and optional repo variable `C00_DOOP_PG_CONTAINER`; empty, `c00.sh` finds the compose project's `db` service (`docker compose ps -q db`) and refuses if there is none. `tests/c00Migrate.test.ts` runs `c00.sh` with the deploy job's real env.
- Not in this slice: the marker write on `migrate_failed`, the compat sandbox (S4c) and rollback sequencing (S5). The switch stays off.

## Compat sandbox and smoke suite (CHE-5474 S4c)

Nothing runs yet: the train switch is off and no workflow calls these. Rules C-8.5b to C-8.5d.

- `scripts/compat-sandbox.mjs`: `runCompat` clones the live database into an `--internal` Docker network (`pg_dump | pg_restore`, no pull, no build, no published port, no mount) and runs the candidate migration on the clone under a 120 s external timeout (C-8.8). After a failed or timed-out migration the run does, inside one 30 s budget with every step bounded: `docker kill`, `docker wait`, record the run's sessions as `(pid, backend_start)`, `pg_terminate_backend`, then prove three facts: container exited, no session of the run left (before and after lists are in the evidence), advisory lock `(1685025648, 1)` free. The clone ledger must also equal the one read before the migration. A step that times out, errors or overruns leaves its fact unproven. Proven is `migrate_failed`; unproven is `needs_operator`: the run writes the guard (below), keeps the sandbox, and skips the final sweep. The proof is in the evidence on success too. It then probes isolation and a failed probe blocks startup: TCP to `1.1.1.1:443`, the default bridge gateway and the live Postgres, DNS for `api.github.com`, the sandbox network's own gateway on ports 22, 53, 80, 443, 2375 and 5432, and a listener the host opens on every interface for the run. The clone database on the sandbox is the positive control: a probe that cannot reach it fails closed. `--internal` alone leaves the bridge gateway address on the host, and a host service bound to it is reachable from the sandbox (observed on Docker 29.6.2), so the network is created with `-o com.docker.network.bridge.inhibit_ipv4=true` (no gateway address at all) and every sandbox container gets an explicit `--ip`, because Docker gives the first free address, the would-be gateway, to the first container that has none. `checkNetworkInspect` refuses a network that has a gateway or a container on that address. The predecessor boots with the seven-key env in `scripts/compat-env.mjs`, then the smoke suite runs from the candidate image. It writes `compat-evidence.json` (candidate SHA, predecessor digest, ledger hash, static / clone / behavior results, `df` before and after). `verifyEvidence` (CLI `verify`) is deploy step 1: evidence for another predecessor digest, ledger hash or candidate SHA is refused.
- `scripts/deploy-smoke.mjs` + `deploy/cd/smoke-routes.json`: an ordered chain of calls per route group against a booted server, as a throwaway user. `write` calls are real operations (create a canvas, rename it, create a frame, comment, agent key, automation, workspace; set notification and local-agent settings; delete an integration) and a later `read` checks the value came back (`expectJson`, values captured with `save`). `contract` calls name the outside service that makes success impossible in the sandbox (Stripe, APNs, a worker token, no egress) and the status that proves the route is up. A group with no write carries a `noWrite` reason. `tests/compatSmoke.test.ts` fails CI when a route group in `server/` has no entry (or an entry has no route), when a placeholder 404 stands in for a write, and when a broken real operation does not fail the suite.
- `c00.sh guard` / `guard-set`: the durable `needs_operator` refusal (C-8.8). `guard-set` writes `$C00_STATE_DIR/compat-unresolved.env` (default `/var/lib/doop-deploy`, or `C00_GUARD_FILE`); it is not a `doop.compat.run` resource, so no sweep removes it. `guard` re-reads the three facts (migration container exited, zero sessions of its `application_name`, advisory key free; each read bounded to 30 s, a failed read counts as unproven), refuses with exit 1 until they hold, then clears the file. `apply`, `rollback`, `sweep` and `compat-sandbox.mjs run` run it first, before they touch anything. The lift job must call `c00.sh guard` before it proceeds. An operator clears a refusal by fixing the state (kill the session, stop the container), then rerunning any job.
- `c00.sh sweep`: removes every `doop.compat.run` container, network and volume, reads back zero, prints `df` before and after. Every C00 compat job runs it first and last; a failed sweep fails the job.
- To add a production key to the predecessor env you must edit `ALLOWED_KEYS` and `tests/compatSandbox.test.ts`; CI fails if a key from `server/env.ts` outside the seven is added.
- `tests/compatIsolationDocker.test.ts` runs the same probe script on a real internal network (needs Docker; skips without it).
