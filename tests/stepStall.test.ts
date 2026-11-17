import { describe, expect, it } from 'vitest'
import { loadWithRetry, step } from './stepStall'

const never = () => new Promise<never>(() => {})

describe('step', () => {
  it('returns the result when the step finishes in time', async () => {
    expect(await step('ok', async () => 7, 200)).toBe(7)
  })

  it('names the step when it stalls', async () => {
    await expect(step('hang', never, 30)).rejects.toThrow('beforeEach step "hang" stalled > 30 ms')
  })

  it('passes the real error through when the step throws', async () => {
    await expect(
      step('bad', async () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
  })
})

describe('loadWithRetry', () => {
  it('loads again when the page is not ready, then returns', async () => {
    let loads = 0
    await loadWithRetry({
      load: async () => void loads++,
      ready: async () => {
        if (loads < 3) throw new Error('not ready')
      },
    })
    expect(loads).toBe(3)
  })

  it('throws the last error, with the diagnosis, once the attempts run out', async () => {
    let loads = 0
    await expect(
      loadWithRetry({
        attempts: 2,
        load: async () => void loads++,
        ready: async () => {
          throw new Error('never ready')
        },
        diagnose: () => 'requestfailed: ERR_NETWORK_CHANGED',
      }),
    ).rejects.toThrow(/never ready[\s\S]*ERR_NETWORK_CHANGED/)
    expect(loads).toBe(2)
  })
})
