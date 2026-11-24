import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElementComment, Frame, FrameVersion } from '../shared/types.ts'

/*
 * CHE-9399 step 1: the persist frame fence. A purge (a later step) must not race a frame write that is
 * on its way to the database, so persist.ts gets a fence a writer checks on entry, a registry of the
 * writes admitted before it, and a settle that waits for them. Nothing here deletes a row.
 *
 * `db` is a stub: every query chain is awaitable, lands in `stub.landed` when it settles, and a test can
 * hold a chain by label ("insert:frames") to keep a write in flight on purpose.
 */

type Op = {
  kind: string
  table?: string
  row?: Record<string, unknown>
  set?: Record<string, unknown>
  returning: boolean
}
type Landed = { label: string; row?: Record<string, unknown>; set?: Record<string, unknown> }
type Hold = {
  label: string
  match?: (op: Op) => boolean
  taken: boolean
  entered: () => void
  gate: Promise<void>
}

const stub = vi.hoisted(() => ({ landed: [] as Landed[], holds: [] as Hold[] }))

vi.mock('../server/db/index.ts', async () => {
  const { getTableName, is, Table } = await import('drizzle-orm')
  const land = async (op: Op) => {
    const label = `${op.kind}:${op.table}`
    const hold = stub.holds.find((h) => !h.taken && h.label === label && (!h.match || h.match(op)))
    if (hold) {
      hold.taken = true
      hold.entered()
      await hold.gate
    }
    stub.landed.push({ label, row: op.row, set: op.set })
    return op.returning ? [{ versionId: 'earlier', id: 'x' }] : []
  }
  const chain = (op: Op): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then')
            return (ok: (v: unknown) => unknown, no: (e: unknown) => unknown) => land(op).then(ok, no)
          return (...args: unknown[]) => {
            if (prop === 'values' && !Array.isArray(args[0])) op.row = args[0] as Record<string, unknown>
            if (prop === 'set') op.set = args[0] as Record<string, unknown>
            if (prop === 'from' && is(args[0], Table)) op.table = getTableName(args[0])
            if (prop === 'returning') op.returning = true
            return chain(op)
          }
        },
      },
    )
  const start =
    (kind: string) =>
    (...args: unknown[]) => {
      const op: Op = { kind, returning: false }
      if (is(args[0], Table)) op.table = getTableName(args[0])
      return chain(op)
    }
  const queries = () => ({
    insert: start('insert'),
    update: start('update'),
    select: start('select'),
    delete: start('delete'),
  })
  const db = {
    ...queries(),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(queries()),
  }
  return { db }
})

const persist = await import('../server/db/persist.ts')
const { fenceFrame, forgetFrame, settleFrameWrites, commentWritesPending, frameWriteState } = persist

/** run every promise reaction that is already queued; the stub has no I/O and no timers of its own */
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

function hold(label: string, match?: (op: Op) => boolean) {
  let entered!: () => void
  let release!: () => void
  let fail!: (err: Error) => void
  const enteredP = new Promise<void>((resolve) => (entered = resolve))
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  stub.holds.push({ label, match, taken: false, entered, gate })
  return { entered: enteredP, release, fail }
}

let seq = 0
const newId = () => `frame-${++seq}`

function frame(id: string, patch: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'canvas-1',
    name: 'Hero',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html: '<p>hi</p>',
    createdAt: 1,
    updatedAt: 2,
    updatedBy: 'Ada',
    ...patch,
  }
}

function version(frameId: string): FrameVersion {
  return {
    id: `v-${frameId}`,
    frameId,
    canvasId: 'canvas-1',
    html: '<p>old</p>',
    width: 100,
    height: 100,
    savedAt: 1,
    savedBy: 'Ada',
    htmlBytes: 10,
  }
}

function keyedWrite(frameId: string) {
  return {
    key: `key-${frameId}`,
    payloadHash: 'h',
    versionId: `kv-${frameId}`,
    savedByKind: 'user' as const,
    version: { html: '<p>v</p>', width: 100, height: 100, savedAt: 3, savedBy: 'Ada' },
    result: { updatedAt: 2, htmlBytes: 8 },
  }
}

function comment(id: string, frameId: string | undefined): ElementComment {
  return { id, canvasId: 'canvas-1', frameId, snippet: '', from: 'Ada', text: 'hi', at: 1 }
}

const landedRows = (label: string, frameId: string, field = 'id') =>
  stub.landed.filter((l) => l.label === label && l.row?.[field] === frameId)

beforeEach(() => {
  stub.landed.length = 0
  stub.holds.length = 0
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('T6a: frame writers entered after the fence', () => {
  it('settle clears a pending debounce', async () => {
    const f = frame(newId())
    persist.saveFrame(f)
    expect(frameWriteState(f.id).timer).toBe(true)
    const fence = fenceFrame(f.id)
    await settleFrameWrites(f.id, { timeoutMs: 1000 })
    expect(frameWriteState(f.id).timer).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(landedRows('insert:frames', f.id)).toHaveLength(0)
    fence.release()
  })

  const immediate: [string, (f: Frame) => Promise<unknown> | void, (id: string) => number][] = [
    ['saveFrame (immediate)', (f) => persist.saveFrame(f, true), (id) => landedRows('insert:frames', id).length],
    ['saveFrameNow', (f) => persist.saveFrameNow(f), (id) => landedRows('insert:frames', id).length],
    [
      'saveFrameVersion',
      (f) => persist.saveFrameVersion(version(f.id)),
      (id) => landedRows('insert:frame_versions', id, 'frameId').length,
    ],
    [
      'saveFramePage',
      (f) => persist.saveFramePage(f.id, `page-of-${f.id}`),
      (id) => stub.landed.filter((l) => l.label === 'update:frames' && l.set?.pageId === `page-of-${id}`).length,
    ],
    [
      'saveFrameTrash',
      (f) => persist.saveFrameTrash({ ...f, deletedAt: 77, pageId: `trash-of-${f.id}` }),
      (id) => stub.landed.filter((l) => l.label === 'update:frames' && l.set?.pageId === `trash-of-${id}`).length,
    ],
  ]

  describe.each(immediate)('%s', (_name, write, landedFor) => {
    it('is held by the fence and runs when the fence is kept', async () => {
      const f = frame(newId())
      const fence = fenceFrame(f.id)
      const done = write(f)
      await flush()
      expect(landedFor(f.id)).toBe(0)
      fence.release()
      await done
      await flush()
      expect(landedFor(f.id)).toBeGreaterThan(0)
    })

    it('is dropped when the frame is purged', async () => {
      const f = frame(newId())
      fenceFrame(f.id)
      const done = write(f)
      forgetFrame(f.id)
      await done
      await flush()
      expect(landedFor(f.id)).toBe(0)
    })
  })

  it('a debounced saveFrame is held when its timer fires after the fence, then runs on kept', async () => {
    const f = frame(newId())
    persist.saveFrame(f)
    const fence = fenceFrame(f.id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(landedRows('insert:frames', f.id)).toHaveLength(0)
    fence.release()
    await flush()
    expect(landedRows('insert:frames', f.id)).toHaveLength(1)
  })

  it('a debounced saveFrame is dropped on purged', async () => {
    const f = frame(newId())
    persist.saveFrame(f)
    fenceFrame(f.id)
    await vi.advanceTimersByTimeAsync(1000)
    forgetFrame(f.id)
    await flush()
    expect(landedRows('insert:frames', f.id)).toHaveLength(0)
  })

  it('retryFrameWrite is held by the fence, then writes on kept', async () => {
    const f = frame(newId())
    persist.saveFrame(f) // dirty, debounce pending
    const fence = fenceFrame(f.id)
    await settleFrameWrites(f.id, { timeoutMs: 1000 }) // clears the timer: dirty with nothing scheduled
    persist.retryFrameWrite(f)
    await vi.advanceTimersByTimeAsync(1000)
    expect(landedRows('insert:frames', f.id)).toHaveLength(0)
    fence.release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(landedRows('insert:frames', f.id)).toHaveLength(1)
  })

  it('retryFrameWrite is dropped on purged', async () => {
    const f = frame(newId())
    persist.saveFrame(f)
    fenceFrame(f.id)
    await settleFrameWrites(f.id, { timeoutMs: 1000 })
    persist.retryFrameWrite(f)
    forgetFrame(f.id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(landedRows('insert:frames', f.id)).toHaveLength(0)
  })

  it('commitKeyedFrameWrite is held by the fence and commits on kept', async () => {
    const f = frame(newId())
    const fence = fenceFrame(f.id)
    let result: unknown = 'pending'
    const done = persist.commitKeyedFrameWrite(f, keyedWrite(f.id)).then((r) => (result = r))
    await flush()
    expect(result).toBe('pending')
    expect(landedRows('insert:frame_write_keys', f.id, 'frameId')).toHaveLength(0)
    fence.release()
    await done
    expect(result).toBeUndefined()
    expect(landedRows('insert:frames', f.id)).toHaveLength(1)
    expect(landedRows('insert:frame_versions', f.id, 'frameId')).toHaveLength(1)
  })

  it('commitKeyedFrameWrite rejects with FramePurgedError on purged and writes nothing', async () => {
    const f = frame(newId())
    fenceFrame(f.id)
    const done = persist.commitKeyedFrameWrite(f, keyedWrite(f.id))
    const caught = done.catch((e: unknown) => e)
    forgetFrame(f.id)
    expect(await caught).toBeInstanceOf(persist.FramePurgedError)
    expect(landedRows('insert:frame_write_keys', f.id, 'frameId')).toHaveLength(0)
  })

  it('a writer for a frame with no fence is not delayed', async () => {
    const f = frame(newId())
    await persist.saveFrameNow(f)
    expect(landedRows('insert:frames', f.id)).toHaveLength(1)
  })
})

describe('T6b: a keyed write admitted before the fence finishes whole', () => {
  it('runs its nested frame write without waiting for the fence; settle waits for the transaction', async () => {
    const f = frame(newId())
    const keyInsert = hold('insert:frame_write_keys')
    const done = persist.commitKeyedFrameWrite(f, keyedWrite(f.id))
    await keyInsert.entered

    const fence = fenceFrame(f.id) // opens while the keyed transaction is mid-flight, never released below
    let settled = false
    const settle = settleFrameWrites(f.id, { timeoutMs: 5000 }).then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)

    keyInsert.release()
    await done
    // the nested writeFrame(frame, tx) and the version row both landed with the fence still up
    expect(landedRows('insert:frames', f.id)).toHaveLength(1)
    expect(landedRows('insert:frame_versions', f.id, 'frameId')).toHaveLength(1)
    await settle
    expect(settled).toBe(true)
    fence.release()
  })

  it('settle rejects with SettleTimeout when an admitted write never ends, and deletes nothing', async () => {
    const f = frame(newId())
    hold('insert:frames') // never released
    const write = persist.saveFrameNow(f)
    await flush()
    fenceFrame(f.id)
    const settle = settleFrameWrites(f.id, { timeoutMs: 300 })
    const caught = settle.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(400)
    expect(await caught).toBeInstanceOf(persist.SettleTimeout)
    expect(stub.landed.filter((l) => l.label.startsWith('delete:frames'))).toHaveLength(0)
    void write
  })
})

describe('T11u: Trash marker', () => {
  it('settle awaits a saveFrameTrash that is in flight', async () => {
    const f = frame(newId())
    const marker = hold('update:frames')
    persist.saveFrameTrash({ ...f, deletedAt: 5 })
    await marker.entered
    fenceFrame(f.id)
    let settled = false
    const settle = settleFrameWrites(f.id, { timeoutMs: 5000 }).then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)
    marker.release()
    await settle
    expect(settled).toBe(true)
    expect(stub.landed.filter((l) => l.label === 'update:frames' && l.set?.deletedAt === 5)).toHaveLength(1)
  })
})

describe('T14u: comment registry', () => {
  it('counts a writeComment and a saveNewComment for the frame, awaits both, and returns to 0', async () => {
    const f = frame(newId())
    const other = newId()
    const fence = fenceFrame(f.id)
    const a = hold('insert:comments', (op) => op.row?.id === 'ca')
    const b = hold('insert:comments', (op) => op.row?.id === 'cb')
    const g = hold('insert:comments', (op) => op.row?.id === 'cg')

    const writeA = persist.saveCommentNow(comment('ca', f.id))
    const writeB = persist.saveNewComment(comment('cb', f.id))
    const writeG = persist.saveCommentNow(comment('cg', other))
    // counted at entry, synchronously
    expect(commentWritesPending(f.id)).toBe(2)
    expect(commentWritesPending(other)).toBe(1)

    // neither write is delayed by the fence
    await a.entered
    await b.entered

    let settled = false
    const settle = settleFrameWrites(f.id, { timeoutMs: 5000 }).then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)

    a.release()
    await writeA
    await flush()
    expect(commentWritesPending(f.id)).toBe(1)
    expect(settled).toBe(false)
    b.release()
    await writeB
    await settle
    expect(settled).toBe(true)
    expect(commentWritesPending(f.id)).toBe(0)

    // frame G's write was not part of F's settle
    expect(commentWritesPending(other)).toBe(1)
    g.release()
    await writeG
    expect(commentWritesPending(other)).toBe(0)
    fence.release()
  })

  it('returns to 0 when the write fails', async () => {
    const f = frame(newId())
    const a = hold('insert:comments', (op) => op.row?.id === 'cf')
    const write = persist.saveCommentNow(comment('cf', f.id))
    const caught = write.catch((e: unknown) => e)
    expect(commentWritesPending(f.id)).toBe(1)
    await a.entered
    a.fail(new Error('connection reset'))
    expect(await caught).toEqual(new Error('connection reset'))
    await flush()
    expect(commentWritesPending(f.id)).toBe(0)
  })

  it('does not count a comment with no frame', async () => {
    await persist.saveCommentNow(comment('cn', undefined))
    expect(commentWritesPending('')).toBe(0)
  })
})

describe('T15u: forgetFrame', () => {
  it('leaves no entry for the frame, and a later saveFrame writes nothing', async () => {
    const f = frame(newId())
    const inFlight = hold('insert:frames')
    persist.saveFrame(f, true) // writesInFlight (held in the stub)
    await inFlight.entered
    persist.saveFrame(f) // dirtyFrames + frameTimers
    const versionHold = hold('select:frame_versions')
    persist.saveFrameVersion(version(f.id)) // versionWrites
    await versionHold.entered
    const before = frameWriteState(f.id)
    expect(before).toEqual({ dirty: true, timer: true, inFlight: true, versions: true })

    fenceFrame(f.id)
    forgetFrame(f.id)
    expect(frameWriteState(f.id)).toEqual({ dirty: false, timer: false, inFlight: false, versions: false })

    persist.saveFrame(f)
    persist.saveFrame(f, true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(frameWriteState(f.id)).toEqual({ dirty: false, timer: false, inFlight: false, versions: false })
    expect(persist.frameWritePending(f.id)).toBe(false)

    inFlight.release()
    versionHold.release()
    await flush()
    // the one write that was already in flight finished; nothing new was written for F
    expect(landedRows('insert:frames', f.id)).toHaveLength(1)
    expect(frameWriteState(f.id)).toEqual({ dirty: false, timer: false, inFlight: false, versions: false })
  })

  it('keeps a tombstone: a writer for the frame arriving later drops', async () => {
    const f = frame(newId())
    forgetFrame(f.id) // no fence was ever open
    await persist.saveFrameNow(f)
    persist.saveFrameTrash(f)
    persist.saveFramePage(f.id, 'p')
    persist.saveFrameVersion(version(f.id))
    await expect(persist.commitKeyedFrameWrite(f, keyedWrite(f.id))).rejects.toBeInstanceOf(persist.FramePurgedError)
    await flush()
    expect(stub.landed).toHaveLength(0)
  })
})
