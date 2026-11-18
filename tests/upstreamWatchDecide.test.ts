import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { decide, parseChild } from '../scripts/upstream-watch/decide.mjs'

/* decision table of CHE-7207 plan r9 ("Admission: the ledger and the watch") */

const H = (c: string) => c.repeat(40)
const C16 = H('b')
const C17 = H('c')

let n = 8000
const base = (o: Record<string, unknown> = {}) => {
  const number = (o.number as number) ?? ++n
  return {
    id: `id-${number}`,
    identifier: `CHE-${number}`,
    number,
    status: 'backlog',
    revision: 3,
    duplicate_of: null,
    metadata: {},
    ...o,
  }
}
const fresh = (version: string, commit: string, o: Record<string, unknown> = {}) =>
  base({
    title: `task(doop): merge upstream doop ${version} into cheese/main`,
    description: `Upstream: kgoedecke/doop v${version} commit ${commit}\n\nbody`,
    ...o,
  })
const legacy = (version: string, o: Record<string, unknown> = {}) =>
  base({
    title: `task(doop): merge upstream doop ${version} into cheese/main and redeploy on C00`,
    description: 'Readiness: ready\nrepo cheese-work/doop',
    ...o,
  })
/** The live CHE-7205 record: legacy title, `Readiness: ready`, key set, in_progress. */
const che7205 = (o: Record<string, unknown> = {}) =>
  legacy('0.15.0', {
    number: 7205,
    identifier: 'CHE-7205',
    status: 'in_progress',
    metadata: { upstream_sync_sha: '9a4fb9ec442a982772b752004761eda3aca2633d' },
    ...o,
  })

const run = (o: Record<string, unknown>) =>
  decide({ tag: 'v0.16.0', commit: C16, inMain: false, children: [], lookupError: null, ...o })

describe('parseChild', () => {
  it('parses the live CHE-7205 record as a claimed v0.15.0', () => {
    expect(parseChild(che7205())).toMatchObject({
      version: '0.15.0',
      commit: '9a4fb9ec442a982772b752004761eda3aca2633d',
      claimed: true,
      live: true,
      form: 'legacy',
    })
  })

  it('treats the same record without upstream_sync_sha as unparseable', () => {
    expect(parseChild(che7205({ metadata: {} }))).toBeNull()
  })

  it('parses a new-form child from its first line', () => {
    expect(parseChild(fresh('0.16.0', C16))).toMatchObject({
      version: '0.16.0',
      commit: C16,
      claimed: false,
      live: true,
      form: 'new',
    })
  })

  it('rejects a new-form child whose first line disagrees with its title', () => {
    expect(
      parseChild(fresh('0.16.0', C16, { description: `Upstream: kgoedecke/doop v0.17.0 commit ${C16}` })),
    ).toBeNull()
  })

  it('rejects an unrelated title and a bad commit', () => {
    expect(parseChild(base({ title: 'something else', description: '' }))).toBeNull()
    expect(parseChild(fresh('0.16.0', 'zz', {}))).toBeNull()
  })

  it('classifies claimed and live by status', () => {
    const p = (status: string) => parseChild(fresh('0.16.0', C16, { status }))
    expect(p('backlog')).toMatchObject({ claimed: false, live: true })
    expect(p('todo')).toMatchObject({ claimed: true, live: true })
    expect(p('done')).toMatchObject({ claimed: false, live: false })
    expect(p('cancelled')).toMatchObject({ claimed: false, live: false })
  })
})

describe('decide', () => {
  it('lookup error: alert only', () => {
    const r = run({ lookupError: 'ls-remote failed', children: [fresh('0.16.0', C16)] })
    expect(r.actions).toEqual([])
    expect(r.alerts.map((a: { code: string }) => a.code)).toEqual(['lookup-error'])
  })

  it('unparseable child (CHE-7205 without its key): alert, zero writes', () => {
    const r = run({ children: [che7205({ metadata: {} })] })
    expect(r.actions).toEqual([])
    expect(r.alerts).toMatchObject([{ code: 'unparseable', key: 'CHE-7205' }])
  })

  it('overlapping v0.16.0 while CHE-7205 is claimed: one backlog child that waits for it', () => {
    const r = run({ children: [che7205()] })
    expect(r.alerts).toEqual([])
    expect(r.actions).toEqual([
      { type: 'create', version: '0.16.0', tag: 'v0.16.0', commit: C16, waitsFor: 'CHE-7205', promote: false },
    ])
  })

  it('claimed older child and a backlog older child: retarget it, do not create', () => {
    const old = fresh('0.15.5', H('d'))
    const r = run({ children: [che7205(), old] })
    expect(r.actions).toEqual([
      {
        type: 'retarget',
        id: old.id,
        key: old.identifier,
        version: '0.16.0',
        tag: 'v0.16.0',
        commit: C16,
        waitsFor: 'CHE-7205',
      },
    ])
  })

  it('retarget never picks a backlog duplicate that is being cancelled: a waiting child for T remains', () => {
    // claimed v0.15.0 (#7205) plus a backlog duplicate of it (#8301): cancel #8301, then create for T
    const dup = legacy('0.15.0', {
      number: 8301,
      metadata: { upstream_sync_sha: '9a4fb9ec442a982772b752004761eda3aca2633d' },
    })
    const r = run({ children: [che7205(), dup] })
    expect(r.actions).toEqual([
      { type: 'cancel_duplicate', id: dup.id, key: 'CHE-8301', duplicateOf: 'CHE-7205' },
      { type: 'create', version: '0.16.0', tag: 'v0.16.0', commit: C16, waitsFor: 'CHE-7205', promote: false },
    ])
    const cancelled = new Set(
      r.actions.filter((a: { type: string }) => a.type === 'cancel_duplicate').map((a: { id: string }) => a.id),
    )
    expect(r.actions.some((a: { type: string; id: string }) => a.type === 'retarget' && cancelled.has(a.id))).toBe(
      false,
    )
  })

  it('no live child, nothing claimed: create, then promote the survivor', () => {
    const r = run({ children: [] })
    expect(r.actions).toEqual([
      { type: 'create', version: '0.16.0', tag: 'v0.16.0', commit: C16, waitsFor: null, promote: true },
    ])
  })

  it('synced tag (commit in cheese/main): no action, no alert', () => {
    const r = run({ inMain: true, children: [che7205(), fresh('0.16.0', C16)] })
    expect(r).toEqual({ alerts: [], actions: [] })
  })

  it('tag moved: live child for T records another commit: alert, no action for T', () => {
    const r = run({ children: [fresh('0.16.0', C17)] })
    expect(r.actions).toEqual([])
    expect(r.alerts).toMatchObject([{ code: 'tag-moved', key: expect.any(String) }])
  })

  it('live backlog child for T with nothing claimed: promote with its revision', () => {
    const c = fresh('0.16.0', C16, { revision: 7 })
    const r = run({ children: [c] })
    expect(r.actions).toEqual([{ type: 'promote', id: c.id, key: c.identifier, revision: 7 }])
  })

  it('live backlog child for T behind a claimed older child: no action', () => {
    const r = run({ children: [che7205(), fresh('0.16.0', C16)] })
    expect(r).toEqual({ alerts: [], actions: [] })
  })

  it('claimed child for T: no action', () => {
    const r = run({ children: [fresh('0.16.0', C16, { status: 'in_progress' })] })
    expect(r).toEqual({ alerts: [], actions: [] })
  })

  it('duplicates: keep the lowest number, cancel the other backlog ones as duplicates', () => {
    const a = fresh('0.16.0', C16, { number: 8101 })
    const b = fresh('0.16.0', C16, { number: 8102 })
    const c = fresh('0.16.0', C16, { number: 8103 })
    const r = run({ children: [c, a, b] })
    expect(r.actions).toEqual([
      { type: 'cancel_duplicate', id: b.id, key: 'CHE-8102', duplicateOf: 'CHE-8101' },
      { type: 'cancel_duplicate', id: c.id, key: 'CHE-8103', duplicateOf: 'CHE-8101' },
      { type: 'promote', id: a.id, key: 'CHE-8101', revision: 3 },
    ])
  })

  it('duplicates: a claimed duplicate raises an alert, is never cancelled, and blocks promotion', () => {
    const a = fresh('0.16.0', C16, { number: 8201 })
    const b = fresh('0.16.0', C16, { number: 8202, status: 'in_progress' })
    const r = run({ children: [a, b] })
    expect(r.actions).toEqual([])
    expect(r.alerts).toMatchObject([{ code: 'claimed-duplicate', key: 'CHE-8202' }])
  })

  it('a child cancelled as a duplicate is not a terminal child for T', () => {
    const dup = fresh('0.16.0', C16, { status: 'cancelled', duplicate_of: 'CHE-8101' })
    const r = run({ children: [dup] })
    expect(r.alerts).toEqual([])
    expect(r.actions).toMatchObject([{ type: 'create', tag: 'v0.16.0', promote: true }])
  })

  it('terminal child without a merge (done, commit not in cheese/main): one alert, rule continues', () => {
    const done = fresh('0.16.0', C16, { status: 'done' })
    const r = run({ children: [done] })
    expect(r.alerts).toMatchObject([{ code: 'terminal-without-merge', key: done.identifier }])
    expect(r.actions).toMatchObject([{ type: 'create', tag: 'v0.16.0', promote: true }])
  })

  it('terminal child without a merge (cancelled, not a duplicate): one alert, rule continues', () => {
    const gone = fresh('0.16.0', C16, { status: 'cancelled' })
    const r = run({ children: [gone] })
    expect(r.alerts).toHaveLength(1)
    expect(r.actions).toHaveLength(1)
  })

  it('2 tags in one interval: only the newest tag is acted on', () => {
    const r = run({ tag: 'v0.17.0', commit: C17, children: [] })
    expect(r.actions).toEqual([
      { type: 'create', version: '0.17.0', tag: 'v0.17.0', commit: C17, waitsFor: null, promote: true },
    ])
  })

  it('2 tags in one interval with a claimed predecessor: waits for the claimed one', () => {
    const r = run({ tag: 'v0.17.0', commit: C17, children: [che7205()] })
    expect(r.actions).toMatchObject([{ type: 'create', tag: 'v0.17.0', waitsFor: 'CHE-7205', promote: false }])
  })

  it('is pure: input is not mutated and the result is JSON-serializable', () => {
    const input = { tag: 'v0.16.0', commit: C16, inMain: false, lookupError: null, children: [che7205()] }
    const before = JSON.stringify(input)
    const r = decide(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
})
