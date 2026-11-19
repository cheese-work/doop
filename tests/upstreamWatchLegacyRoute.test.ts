import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs fixture, no type declarations
import { LEGACY_AUTOPILOT_ID, runLegacyPartC } from './fixtures/fake-legacy-route.mjs'
// @ts-expect-error plain .mjs fixture, no type declarations
import { fakeCli } from './fixtures/fake-multica/client.mjs'

/* The old route's part C (autopilot 984cd96a) as a fake, moving rule included (CHE-7207 S1a). */

const BEFORE_FILE = 'scripts/upstream-watch/legacy-before.md'
const BEFORE_SHA = '07eebc9c95970144acee792d5f2cd8e04c76af9e0a4dfe13bc00f0a5efc0cc83'
const SQUAD = 'a1073a68-4965-44ff-a8fb-244341935110'
const TAG = { tag: 'v0.16.0', commit: 'b'.repeat(40), inMain: false, tagAgeDays: 1 }

let dir: string
let state: string
let cli: (args: string[]) => unknown
let before: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fake-legacy-'))
  state = path.join(dir, 'state.json')
  before = await readFile(BEFORE_FILE, 'utf8')
  cli = fakeCli(state)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const issue = (n: number, o: Record<string, unknown> = {}) => ({
  id: `i-${n}`,
  identifier: `CHE-${n}`,
  number: n,
  status: 'backlog',
  revision: 1,
  metadata: {},
  comments: [],
  assignee_id: SQUAD,
  ...o,
})
const waiting = (o: Record<string, unknown> = {}) =>
  issue(9101, { title: 'task(doop): merge upstream doop 0.16.0 into cheese/main', ...o })
const claimed = issue(7205, {
  title: 'task(doop): merge upstream doop 0.15.0 into cheese/main and redeploy on C00',
  status: 'in_progress',
})
const seed = (issues: unknown[], description = before) =>
  writeFile(
    state,
    JSON.stringify({
      issues,
      autopilots: {
        [LEGACY_AUTOPILOT_ID]: {
          id: LEGACY_AUTOPILOT_ID,
          title: 't',
          description,
          status: 'active',
          updated_at: '2026-11-18T04:15:51Z',
          triggers: [],
          runs: [],
        },
      },
    }),
  )
const read = async () => JSON.parse(await readFile(state, 'utf8'))
const byId = async (id: string) => (await read()).issues.find((i: { id: string }) => i.id === id)
const stripPartC = (d: string) => d.replace(/## Part C: doop[\s\S]*?(?=## Failures)/, '')

describe('legacy-before.md fixture', () => {
  it('is the live description (hash)', () => {
    expect(createHash('sha256').update(before).digest('hex')).toBe(BEFORE_SHA)
  })

  it('still holds the moving-rule sentence and the part C step 3 lines word for word', () => {
    expect(before).toContain(
      'Moving rule (CHE-4583): a sync or upgrade issue must move. Every issue a part files is created with `--status todo` and an assignee, never `backlog`. Whenever a part finds an open issue for its tag or version in `backlog`, run `multica issue status <id> todo`; if it has no assignee, assign the dev team squad a1073a68-4965-44ff-a8fb-244341935110. Read the status back. Do this before the part ends, including the "end silently" paths.',
    )
    expect(before).toContain(
      '3. Is a sync open? Search issues in the whole workspace, not in a done or closed status category, whose title contains `merge upstream doop`. The title carries the version without `v` (`merge upstream doop 0.12.0 into cheese/main`).\n   - One exists for this version: apply the moving rule, then end part C silently.\n   - One exists for an older version (for example CHE-2734): apply the moving rule, post one comment on it naming the new tag and SHA (only if no comment names this tag yet), then end part C.',
    )
  })

  it('the after-text (no part C) makes the fake a no-op', async () => {
    await seed([waiting(), claimed], stripPartC(before))
    expect(runLegacyPartC({ cli, ...TAG })).toMatchObject({ ended: 'no-part-c' })
    expect((await read()).calls).toBe(1) // one autopilot get, nothing else
    expect(await byId('i-9101')).toMatchObject({ status: 'backlog' })
  })
})

describe('fake legacy route, before-text', () => {
  it('newest stable tag already in cheese/main: ends, writes nothing', async () => {
    await seed([waiting()])
    expect(runLegacyPartC({ cli, ...TAG, inMain: true })).toMatchObject({ ended: 'synced' })
    expect(await byId('i-9101')).toMatchObject({ status: 'backlog', revision: 1 })
  })

  it('open issue for this version in backlog: moving rule starts it, then ends', async () => {
    await seed([waiting()])
    expect(runLegacyPartC({ cli, ...TAG })).toMatchObject({ ended: 'open-for-version' })
    expect(await byId('i-9101')).toMatchObject({ status: 'todo' })
    expect((await read()).issues).toHaveLength(1)
  })

  it('same, no assignee: assigns the dev team squad', async () => {
    await seed([waiting({ assignee_id: null })])
    runLegacyPartC({ cli, ...TAG })
    expect(await byId('i-9101')).toMatchObject({ status: 'todo', assignee_id: SQUAD })
  })

  it('open issue for this version already past backlog: no write', async () => {
    await seed([waiting({ status: 'todo' })])
    runLegacyPartC({ cli, ...TAG })
    expect(await byId('i-9101')).toMatchObject({ status: 'todo', revision: 1 })
  })

  it('open issue for an older version: moving rule, one comment naming the new tag, then ends', async () => {
    await seed([issue(7300, { title: 'task(doop): merge upstream doop 0.15.0 into cheese/main and redeploy on C00' })])
    expect(runLegacyPartC({ cli, ...TAG })).toMatchObject({ ended: 'open-for-older' })
    runLegacyPartC({ cli, ...TAG }) // second run: no second comment
    const i = await byId('i-7300')
    expect(i.status).toBe('todo')
    expect(i.comments).toHaveLength(1)
    expect(i.comments[0].content).toContain('v0.16.0')
    expect(i.comments[0].content).toContain('b'.repeat(40))
  })

  it('no open sync issue: files one issue in todo, with the squad, high priority, Readiness ready', async () => {
    await seed([])
    expect(runLegacyPartC({ cli, ...TAG, tagAgeDays: 10 })).toMatchObject({ ended: 'filed' })
    runLegacyPartC({ cli, ...TAG, tagAgeDays: 10 }) // second run finds the one it filed
    const { issues } = await read()
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      title: 'task(doop): merge upstream doop 0.16.0 into cheese/main and redeploy on C00',
      status: 'todo',
      assignee_id: SQUAD,
      priority: 'high',
      properties: { Readiness: 'ready' },
    })
  })

  it('done and cancelled issues do not count as open', async () => {
    await seed([
      waiting({ status: 'done' }),
      waiting({ id: 'i-9102', identifier: 'CHE-9102', number: 9102, status: 'cancelled' }),
    ])
    expect(runLegacyPartC({ cli, ...TAG })).toMatchObject({ ended: 'filed' })
  })

  it('files one issue even when only a `sync upstream v` titled issue is open (gap guard does not double-file)', async () => {
    await seed([issue(5733, { title: 'sync upstream v0.14.0 into cheese/main', status: 'in_progress' })])
    runLegacyPartC({ cli, ...TAG, tagAgeDays: 10 })
    expect((await read()).issues.filter((i: { title: string }) => /merge upstream doop/.test(i.title))).toHaveLength(1)
  })
})

describe('M1 control: restoring the old route while a child waits', () => {
  it('while S is claimed the moving rule promotes the waiting backlog child W (why rollback step 5 waits)', async () => {
    await seed([claimed, waiting()])
    runLegacyPartC({ cli, ...TAG })
    expect(await byId('i-9101')).toMatchObject({ status: 'todo' })
  })

  it('after W is already in todo, the restored route makes no write and files nothing', async () => {
    await seed([claimed, waiting({ status: 'todo' })])
    const calls0 = (await read()).calls ?? 0
    runLegacyPartC({ cli, ...TAG })
    const s = await read()
    expect(s.issues).toHaveLength(2)
    expect(await byId('i-9101')).toMatchObject({ status: 'todo', revision: 1 })
    expect(s.calls - calls0).toBeLessThanOrEqual(3) // autopilot get, search, one read-back: no write
  })
})
