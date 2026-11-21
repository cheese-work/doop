import { describe, expect, it } from 'vitest'
import { erusLike } from '../scripts/perf/measure-lag.ts'
import { withLocalDoop } from '../scripts/perf/measure-local.ts'

/* CHE-8976: the lag script is a command, not a library, so a missing helper
   only shows when somebody runs it. Importing it resolves every helper it needs
   (import-canvas-export, measure-local, measure-canvas-load). */
describe('measure-lag', () => {
  it('loads with all its helpers and builds the erus-like file', () => {
    expect(typeof withLocalDoop).toBe('function')
    const file = erusLike()
    expect(file.frames).toHaveLength(207 + 154 + 87 + 18 + 100 + 79)
    expect(file.frames[0]).toMatchObject({ width: 390, height: 844 })
  })

  it('takes the frame sizes from a list', () => {
    const file = erusLike([
      [100, 200],
      [300, 400],
    ])
    expect(file.frames.map((f) => [f.width, f.height])).toEqual([
      [100, 200],
      [300, 400],
    ])
  })
})
