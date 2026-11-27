import { create } from 'zustand'
import type { Frame } from '../../shared/types'
import { ApiError } from './api'
import { t } from './i18n'
import { useStore } from './store'

/* U1 (CHE-9395): what the lock UI shows and says. The wire fields are S1's:
   lockedBy, lockedAt (ms), lockReason on the frame, and a 423 body
   { code: 'frame_locked', lockedBy, lockedAt, reason }. People read ICT. */

const ICT = 'Asia/Ho_Chi_Minh'

function ictParts(at: number) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ICT,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${get('day')} ${get('month')} ${get('year')}`, time: `${get('hour')}:${get('minute')}` }
}

/** "16:20 ICT" */
export function ictTime(at: number): string {
  return `${ictParts(at).time} ICT`
}

/** "13 Nov 2026 16:20 ICT" */
export function ictDateTime(at: number): string {
  const { date, time } = ictParts(at)
  return `${date} ${time} ICT`
}

/** "Locked · Cheese · 16:20 ICT". A lock made before S1 recorded who and when
 *  is a bare "Locked". */
export function lockMarker(frame: Pick<Frame, 'lockedBy' | 'lockedAt'>): string {
  return [t('inspector.locked'), frame.lockedBy, frame.lockedAt ? ictTime(frame.lockedAt) : undefined]
    .filter(Boolean)
    .join(' · ')
}

/** "Locked by Cheese on 13 Nov 2026 16:20 ICT." — whatever of it is known */
export function lockedByLine(by?: string, at?: number): string {
  if (by && at) return t('panels.lockedByOn', { by, when: ictDateTime(at) })
  if (by) return t('panels.lockedBy', { by })
  return ''
}

/** The 423 a locked frame answers an edit with, as the toast: who, when, why. */
export function lockedRefusal(err: unknown, frame: Pick<Frame, 'name'>): string | null {
  if (!(err instanceof ApiError) || err.status !== 423 || err.body.code !== 'frame_locked') return null
  const by = typeof err.body.lockedBy === 'string' ? err.body.lockedBy : undefined
  const at = typeof err.body.lockedAt === 'number' ? err.body.lockedAt : undefined
  const reason = typeof err.body.reason === 'string' && err.body.reason ? err.body.reason : undefined
  return [
    t('panels.lockRefusedHead', { name: frame.name }),
    lockedByLine(by, at),
    reason ? t('panels.lockRefusedReason', { reason }) : '',
    t('panels.lockRefusedTail'),
  ]
    .filter(Boolean)
    .join(' ')
}

/** An unlock the server will not make: 403, or a 423 policy refusal. The frame
 *  stays locked. Anything else that is an ApiError is a plain failure. */
export function isUnlockRefusal(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.status === 403 || (err.status === 423 && err.body.code === 'policy_refused'))
}

/** The lock fields a re-read frame carries, to put over the local copy. */
export function lockFields(f: Frame): Partial<Frame> {
  return {
    locked: !!f.locked,
    lockedBy: f.lockedBy,
    lockedAt: f.lockedAt,
    lockReason: f.lockReason,
    lockEpoch: f.lockEpoch,
  }
}

/* The lock UI's own state, apart from the canvas store: the one confirm every
   unlock entry point raises, the refusal the A1 error state shows, and the
   frames whose lock state is being re-read after a lost reply. */
export type UnlockRequest = { frameIds: string[] }
/** `status` is the refusing server's code, or null when the lock state itself
 *  could not be read back after a lost reply. */
export type LockError = { frameIds: string[]; name: string; status: number | null }

/** A refused edit, kept for the phone Inspector: its sheet covers the toast. */
export type LockRefusal = { frameId: string; text: string }

export const useLockUi = create<{
  confirm: UnlockRequest | null
  error: LockError | null
  refusal: LockRefusal | null
  reading: string[]
}>(() => ({ confirm: null, error: null, refusal: null, reading: [] }))

/** Say a refused edit twice: as the toast, and where an open phone sheet shows it. */
export function noteRefusal(frameId: string, text: string) {
  useStore.getState().pushNotice(text)
  useLockUi.setState({ refusal: { frameId, text } })
}

export function setReading(frameId: string, on: boolean) {
  useLockUi.setState((s) => ({
    reading: on ? [...s.reading.filter((id) => id !== frameId), frameId] : s.reading.filter((id) => id !== frameId),
  }))
}
