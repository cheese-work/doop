import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/* CHE-6626: the lock, its attestation id and its epoch reach a real database (temporary pglite, nothing
   mocked) and come back on hydrate. The persistence layer is not stubbed here, unlike frameLockPolicy.test.ts. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-framelock-'))
const cwd = process.cwd()
process.chdir(dir)
const dbm = await import('../server/db/index.ts')
const t = await import('../server/db/schema.ts')
const persist = await import('../server/db/persist.ts')
const { store } = await import('../server/store.ts')
const { PolicyRefused, setLockOwners, systemContext } = await import('../server/writePolicy.ts')
await dbm.initDb()
process.chdir(cwd)

const sys = systemContext()
const cheese = { kind: 'user' as const, userId: 'cheese' }
const agent = { kind: 'agent' as const }

beforeAll(() => setLockOwners(['cheese']))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

async function row(frameId: string) {
  await persist.flush((id) => store.getFrame(id))
  const [r] = await dbm.db.select().from(t.frames).where(eq(t.frames.id, frameId))
  return r
}

async function frameOnDisk() {
  const canvas = store.createCanvas('Lock db', 'alice')
  const frame = store.createFrame(sys, canvas.id, { name: 'f', html: '<p>v1</p>' }, 'x')!
  /* the canvas row is written fire-and-forget; the frame row needs it */
  await vi.waitFor(async () => {
    const [c] = await dbm.db.select().from(t.canvases).where(eq(t.canvases.id, canvas.id))
    expect(c).toBeTruthy()
  })
  return { canvas, frame: { ...frame } }
}

describe('frame lock in a real database', () => {
  it('lock_if_version writes locked and the attestation id; unlock writes the epoch and clears the id', async () => {
    const { frame } = await frameOnDisk()
    expect(store.lockIfVersion(agent, frame.id, frame.updatedAt, 'att-1')).toMatchObject({ ok: true })
    expect(await row(frame.id)).toMatchObject({ locked: true, lockAttestationId: 'att-1', lockEpoch: null })

    store.updateFrame(cheese, frame.id, { locked: false }, 'cheese')
    expect(await row(frame.id)).toMatchObject({ locked: false, lockAttestationId: null, lockEpoch: 1 })
  })

  it('hydrate brings the lock, the attestation id and the epoch back', async () => {
    const { frame } = await frameOnDisk()
    store.lockIfVersion(agent, frame.id, frame.updatedAt, 'att-h')
    await row(frame.id)
    const locked = (await persist.hydrate()).canvases.flatMap((c) => c.frames).find((f) => f.id === frame.id)
    expect(locked).toMatchObject({ locked: true, lockAttestationId: 'att-h' })

    store.updateFrame(cheese, frame.id, { locked: false }, 'cheese')
    await row(frame.id)
    const unlocked = (await persist.hydrate()).canvases.flatMap((c) => c.frames).find((f) => f.id === frame.id)
    expect(unlocked).toMatchObject({ lockEpoch: 1 })
    expect(unlocked?.locked).toBeFalsy()
    expect(unlocked?.lockAttestationId).toBeUndefined()
  })

  it('a second lock call with another attestation is refused and the stored id stays', async () => {
    const { frame } = await frameOnDisk()
    store.lockIfVersion(agent, frame.id, frame.updatedAt, 'att-first')
    expect(() => store.lockIfVersion(agent, frame.id, frame.updatedAt, 'att-other')).toThrow(PolicyRefused)
    expect(await row(frame.id)).toMatchObject({ locked: true, lockAttestationId: 'att-first' })
  })

  it('the same attestation again is a no-op: no new database write', async () => {
    const { frame } = await frameOnDisk()
    store.lockIfVersion(agent, frame.id, frame.updatedAt, 'att-same')
    const before = await row(frame.id)
    expect(store.lockIfVersion(agent, frame.id, frame.updatedAt, 'att-same')).toMatchObject({ ok: true })
    expect(await row(frame.id)).toEqual(before)
  })

  it('lock, flush, unlock, edit and an immediate relock: the edited html and size are stored and hydrate (P1, CHE-8992 review)', async () => {
    const { frame } = await frameOnDisk()
    store.lockIfVersion(agent, frame.id, frame.updatedAt, 'att-a')
    expect(await row(frame.id)).toMatchObject({ locked: true, html: '<p>v1</p>' })

    /* nothing is flushed between the three writes: the unlock and the edit are still waiting on their
       debounce when the relock saves at once, so the stored row is still the first lock */
    store.updateFrame(cheese, frame.id, { locked: false }, 'cheese')
    const edited = store.updateFrame(sys, frame.id, { html: '<p>v2</p>', width: 777, height: 555 }, 'x')!
    expect(store.lockIfVersion(agent, frame.id, edited.updatedAt, 'att-b')).toMatchObject({ ok: true })

    expect(await row(frame.id)).toMatchObject({
      locked: true,
      lockAttestationId: 'att-b',
      lockEpoch: 1,
      html: '<p>v2</p>',
      width: 777,
      height: 555,
    })
    const back = (await persist.hydrate()).canvases.flatMap((c) => c.frames).find((f) => f.id === frame.id)
    expect(back).toMatchObject({ locked: true, lockAttestationId: 'att-b', lockEpoch: 1, width: 777, height: 555 })
  })

  it('a stale write from the same lock epoch still cannot change the stored html of a locked frame', async () => {
    const { frame } = await frameOnDisk()
    store.lockIfVersion(agent, frame.id, frame.updatedAt, 'att-c')
    await row(frame.id)
    const live = store.getFrame(frame.id)!
    const stale = { ...live, html: '<p>sneaky</p>', width: 1, height: 1 }
    persist.saveFrame(stale, true)
    expect(await row(frame.id)).toMatchObject({ locked: true, html: '<p>v1</p>' })
  })
})
