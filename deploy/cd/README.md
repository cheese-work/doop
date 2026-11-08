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
- Rebase and merge-queue merges whose commit differs from the pull request's `merge_commit_sha`
  are not matched and deploy by dispatch only.

## What the deploy does (`c00.sh`)

1. `apply`: tags the running image `doop-rollback:previous`, pulls `ghcr.io/cheese-work/doop@sha256:...`,
   starts it with `compose.image.yml` (`--no-build --pull never`). A ref that is not a 64-hex digest is refused.
2. `readback`: the running image has the evidence digest; its `org.opencontainers.image.revision`
   label equals the deployed SHA; the container reports `healthy` on 3 consecutive checks inside
   15 minutes. `unhealthy` or a stopped container fails at once.
3. `rollback` (only on failure): starts `doop-rollback:previous` and waits up to 5 minutes for `healthy`.
   The job stays failed, which suspends auto-deploy. On a first deploy there is nothing to roll back to.

## Prerequisites (set once; not in this repo)

| Where         | Name                      | Value                                                                                                       |
| ------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Runner        | label `cheese-c00-deploy` | self-hosted runner on C00 with Docker and `docker compose`, in a runner group limited to `cheese-work/doop` |
| Repo variable | `C00_DOOP_COMPOSE_DIR`    | directory on C00 with the doop compose project (service `doop`, its `.env`)                                 |
| Repo variable | `C00_DEPLOY_AUTHORIZERS`  | extra logins, e.g. the agent-merge identity                                                                 |
| Repo variable | `MAIN_RED_PAUSED`         | empty, or a reason to pause                                                                                 |

Optional on the runner: `C00_COMPOSE_FILE` (default `docker-compose.yml`), `C00_CONTAINER` (default `doop`).

Rollback-by-digest has not been drilled yet (slice C). Until then the first live deploy needs Cheese's go-ahead.
