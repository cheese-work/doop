// The old doop route (autopilot 984cd96a, part C of scripts/upstream-watch/legacy-before.md)
// as a fake, moving rule included (CHE-4583). It acts only when the autopilot's description
// is exactly the before-text; with any other text (the after-text drops part C) it does nothing.
// If the live text changes, upstreamWatchLegacyRoute.test.ts fails and this file must change with it.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const LEGACY_AUTOPILOT_ID = '984cd96a-6c54-4802-90d1-c560d8df16a6'
const SQUAD = 'a1073a68-4965-44ff-a8fb-244341935110'
const PROJECT = '5e621e12-eeb4-40a5-9571-25657d5b0ec5'
const BEFORE = readFileSync(new URL('../../scripts/upstream-watch/legacy-before.md', import.meta.url), 'utf8')
const sha = (s) => createHash('sha256').update(s).digest('hex')
const cmp = (a, b) =>
  a
    .split('.')
    .map(Number)
    .reduce((d, x, i) => d || x - Number(b.split('.')[i]), 0)

/** Moving rule: a backlog issue goes to todo; no assignee gets the dev team squad; read back. */
function movingRule(cli, issue) {
  if (issue.status === 'backlog') cli(['issue', 'status', issue.id, 'todo'])
  if (!issue.assignee_id) cli(['issue', 'assign', issue.id, '--to-id', SQUAD])
  return cli(['issue', 'get', issue.id])
}

/**
 * Part C, steps 1-4. `cli(args)` is the fake CLI client; `tag`/`commit`/`inMain` come from the
 * (faked) git steps 1-2. Returns { ended } naming the branch taken.
 */
export function runLegacyPartC({ cli, tag, commit, inMain }) {
  const { autopilot } = cli(['autopilot', 'get', LEGACY_AUTOPILOT_ID])
  if (sha(autopilot.description ?? '') !== sha(BEFORE)) return { ended: 'no-part-c' }
  if (inMain) return { ended: 'synced' } // step 2: ahead or identical

  // step 3: open issues titled `merge upstream doop`, version without `v`
  const version = tag.replace(/^v/, '')
  const open = cli(['issue', 'search', 'merge upstream doop']).issues.map((i) => ({
    issue: i,
    version: /merge upstream doop (\d+\.\d+\.\d+)/.exec(i.title)?.[1],
  }))
  const same = open.find((o) => o.version === version)
  if (same) {
    movingRule(cli, same.issue)
    return { ended: 'open-for-version' }
  }
  const older = open.find((o) => o.version && cmp(o.version, version) < 0)
  if (older) {
    const i = movingRule(cli, older.issue)
    if (!i.comments.some((c) => c.content.includes(tag))) {
      cli([
        'issue',
        'comment',
        'add',
        i.id,
        '--content',
        `Upstream doop ${tag} (${commit}) is out; this sync is for an older version.`,
      ])
    }
    return { ended: 'open-for-older' }
  }

  // step 4: file one issue. The gap guard (no open sync issue, tag over 3 days old) files
  // under the same condition, so step 4 has already filed by the time it could fire.
  const issue = cli([
    'issue',
    'create',
    '--title',
    `task(doop): merge upstream doop ${version} into cheese/main and redeploy on C00`,
    '--assignee-id',
    SQUAD,
    '--project',
    PROJECT,
    '--priority',
    'high',
    '--status',
    'todo',
    '--property',
    'Readiness=ready',
    '--description',
    `repo cheese-work/doop, target cheese/main, tag ${tag}, SHA ${commit}`,
  ])
  return { ended: 'filed', issue }
}
