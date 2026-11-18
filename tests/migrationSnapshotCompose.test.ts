import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { composeSnapshots, diffSnapshotObjects, generateSnapshot } from '../scripts/migration-snapshot-compose.mjs'

/* CHE-7297 (S3c of CHE-7207): the snapshot composer for upstream syncs. Real data, taken from git:
   - fork-port: base `cheese/main` 484f9d85 0054 (58 tables); incoming `main` 0a07e84e 0038 (the shared
     predecessor) and 0039-0042; the resolved schema is the 18 Nov trial merge of those two, unioned by hand
     for canvases (none), frames, tasks and the new design_attestations table;
   - upstream: the same base; incoming upstream v0.15.0 0048 (predecessor) and 0049-0059. */
type Json = Record<string, any> // eslint-disable-line typescript/no-explicit-any
const fx = (...p: string[]) => path.resolve('tests/fixtures/snapshot-compose', ...p)
const gz = (...p: string[]) => JSON.parse(gunzipSync(readFileSync(fx(...p))).toString('utf8')) as Json
const base = () => JSON.parse(readFileSync('server/db/migrations/meta/0054_snapshot.json', 'utf8')) as Json
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const strip = (s: Json) => {
  const { id: _id, prevId: _prevId, ...rest } = s
  return rest
}

describe('fork port with a schema conflict', () => {
  const incoming = gz('fork-port', 'incoming.json.gz') as unknown as Json[]
  const run = () => composeSnapshots(base(), incoming) as { ok: true; snapshots: Json[] }

  it('composes one snapshot per incoming entry, chained from the base tail', () => {
    const b = base()
    const r = run()
    expect(r.ok).toBe(true)
    expect(r.snapshots).toHaveLength(4)
    expect(r.snapshots[0]!.prevId).toBe(b.id)
    r.snapshots.forEach((s, i) => {
      if (i > 0) expect(s.prevId).toBe(r.snapshots[i - 1]!.id)
      expect(s.id).not.toBe(b.id)
    })
  })

  it('keeps the fork tables and merges both lines columns', () => {
    for (const s of run().snapshots) {
      expect(Object.keys(s.tables)).toEqual(expect.arrayContaining(['public.comment_events', 'public.page_snapshots']))
    }
    const last = run().snapshots[3]!.tables
    const cols = (t: string) => Object.keys(last[`public.${t}`].columns)
    expect(cols('frames')).toEqual(expect.arrayContaining(['z', 'rotation', 'lock_epoch', 'lock_attestation_id']))
    expect(cols('tasks')).toEqual(expect.arrayContaining(['runner', 'multica_task_id']))
    expect(cols('canvases')).toEqual(expect.arrayContaining(['project_id', 'token_themes']))
    expect(last).toHaveProperty(['public.design_attestations'])
  })

  it('composed_4 equals generateDrizzleJson of the resolved schema', async () => {
    const generated = (await generateSnapshot([fx('fork-port/schema.ts'), fx('fork-port/auth-schema.ts')])) as Json
    expect(diffSnapshotObjects(run().snapshots[3], generated)).toEqual([])
  })

  it('never edits the base snapshot', () => {
    const b = base()
    const before = clone(b)
    composeSnapshots(b, incoming)
    expect(b).toEqual(before)
  })
})

describe('upstream v0.15.0 over the fork base', () => {
  // The hand-composed 0065 of CHE-7205 (595f606a) lost ten fork objects its own schema.ts still declares. The
  // composer keeps them, so the tail equals that file once they are put back from the base.
  const LOST_BY_HAND = [
    'tables.public.canvas_bridge',
    'tables.public.canvases.columns.deleted_pages',
    'tables.public.comment_events',
    'tables.public.comments.columns.client_request_id',
    'tables.public.comments.indexes.comments_thread_request_idx',
    'tables.public.frame_versions.columns.name',
    'tables.public.frame_write_keys',
    'tables.public.frames.columns.deleted_at',
    'tables.public.page_snapshots',
    'tables.public.snapshot_blobs',
  ]
  // 'tables.public.t.columns.c' -> ['tables', 'public.t', 'columns', 'c'] (a table key holds a dot)
  const keys = (p: string) => ['tables', p.split('.').slice(1, 3).join('.'), ...p.split('.').slice(3)]
  const at = (s: Json, p: string) => keys(p).reduce<Json>((o, k) => o[k]!, s)
  const put = (s: Json, p: string, v: unknown) => {
    const k = keys(p)
    k.slice(0, -1).reduce<Json>((o, key) => o[key]!, s)[k.at(-1)!] = v
  }

  it('composes 11 snapshots; the tail is the 18 Nov CHE-7205 merge tail plus the ten fork objects it lost', () => {
    const incoming = gz('upstream', 'incoming.json.gz') as unknown as Json[]
    const r = composeSnapshots(base(), incoming) as { ok: true; snapshots: Json[] }
    expect(r.ok).toBe(true)
    expect(r.snapshots).toHaveLength(11)
    const tail = r.snapshots[10]!
    const byHand = gz('upstream', 'che7205-0065.json.gz')
    expect(diffSnapshotObjects(tail, byHand).sort()).toEqual([...LOST_BY_HAND].sort())
    for (const p of LOST_BY_HAND) put(byHand, p, clone(at(base(), p)))
    expect(strip(tail)).toEqual(strip(byHand))
  })
})

describe('stops and no-ops', () => {
  const snap = (columns: Json, extra: Json = {}): Json => ({
    id: 'x',
    prevId: 'y',
    version: '7',
    dialect: 'postgresql',
    tables: { 'public.t': { name: 't', schema: '', columns, indexes: {}, foreignKeys: {}, ...extra } },
    enums: {},
    schemas: {},
    sequences: {},
    roles: {},
    policies: {},
    views: {},
    _meta: { columns: {}, schemas: {}, tables: {} },
  })
  const col = (name: string, type = 'text') => ({ name, type, primaryKey: false, notNull: false })

  it('adds an absent column', () => {
    const r = composeSnapshots(snap({ a: col('a') }), [snap({ a: col('a') }), snap({ a: col('a'), b: col('b') })])
    expect(r.ok).toBe(true)
    expect(Object.keys(r.snapshots[0].tables['public.t'].columns)).toEqual(['a', 'b'])
  })

  it('treats an add of an identical object as a no-op', () => {
    const r = composeSnapshots(snap({ a: col('a'), b: col('b') }), [
      snap({ a: col('a') }),
      snap({ a: col('a'), b: col('b') }),
    ])
    expect(r.ok).toBe(true)
    expect(Object.keys(r.snapshots[0].tables['public.t'].columns)).toEqual(['a', 'b'])
  })

  it('stops on an add of an existing, different column', () => {
    const r = composeSnapshots(snap({ a: col('a'), b: col('b', 'integer') }), [
      snap({ a: col('a') }),
      snap({ a: col('a'), b: col('b') }),
    ])
    expect(r).toMatchObject({ ok: false, step: 1, op: 'add', path: 'tables.public.t.columns.b' })
  })

  it('stops on a modify of an absent column', () => {
    const r = composeSnapshots(snap({ a: col('a') }), [
      snap({ a: col('a'), b: col('b') }),
      snap({ a: col('a'), b: col('b', 'integer') }),
    ])
    expect(r).toMatchObject({ ok: false, step: 1, op: 'modify', path: 'tables.public.t.columns.b' })
  })

  it('modifies a column equal to old, and treats one already at new as a no-op', () => {
    const inc = [snap({ b: col('b') }), snap({ b: col('b', 'integer') })]
    expect(composeSnapshots(snap({ b: col('b') }), inc).snapshots[0].tables['public.t'].columns.b.type).toBe('integer')
    expect(composeSnapshots(snap({ b: col('b', 'integer') }), inc).ok).toBe(true)
    expect(composeSnapshots(snap({ b: col('b', 'bigint') }), inc)).toMatchObject({ ok: false, op: 'modify' })
  })

  it('removes a column equal to old, and stops on a different or absent one', () => {
    const inc = [snap({ a: col('a'), b: col('b') }), snap({ a: col('a') })]
    expect(
      Object.keys(composeSnapshots(snap({ a: col('a'), b: col('b') }), inc).snapshots[0].tables['public.t'].columns),
    ).toEqual(['a'])
    expect(composeSnapshots(snap({ a: col('a'), b: col('b', 'integer') }), inc)).toMatchObject({
      ok: false,
      op: 'remove',
    })
    expect(composeSnapshots(snap({ a: col('a') }), inc)).toMatchObject({ ok: false, op: 'remove' })
  })

  it('follows table attributes, enums and added tables', () => {
    const next = snap({ a: col('a') }, { isRLSEnabled: true })
    next.enums = { 'public.e': { name: 'e', schema: 'public', values: ['x'] } }
    next.tables['public.u'] = { name: 'u', schema: '', columns: { id: col('id') }, indexes: {}, foreignKeys: {} }
    const r = composeSnapshots(snap({ a: col('a') }), [snap({ a: col('a') }), next])
    expect(r.ok).toBe(true)
    expect(r.snapshots[0].tables['public.t'].isRLSEnabled).toBe(true)
    expect(r.snapshots[0].enums).toHaveProperty(['public.e'])
    expect(r.snapshots[0].tables).toHaveProperty(['public.u'])
  })
})

describe('diffSnapshotObjects', () => {
  it('ignores id and prevId and names the differing path', () => {
    const a = { id: '1', prevId: '2', tables: { t: { columns: { a: { type: 'text' } } } } }
    expect(diffSnapshotObjects(a, { ...a, id: '3', prevId: '4' })).toEqual([])
    expect(diffSnapshotObjects(a, { ...a, tables: { t: { columns: { a: { type: 'integer' } } } } })).toEqual([
      'tables.t.columns.a.type',
    ])
  })
})
