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
  finished deploy in the last 100 runs counts, each attempt of a rerun too, and the latest finish decides. A
  failure and a success that finish at the same instant count as the failure. A deploy still running says
  nothing yet. A finished deploy with no completion time fails the gate.
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
