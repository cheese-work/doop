/*
 * Test-only preload for tests/framePurgeReboot.test.ts (CHE-9646). The child server runs with
 * `NODE_OPTIONS=--import <this file>` and DOOP_PURGE_HOLD_DIR=<dir>. Nothing happens until the test writes
 * `<dir>/armed` (its content is the frame id). Then the next transaction whose first statement is the purge's
 * `set local statement_timeout` is held before that statement runs, which is after the route took its lease and
 * settled the frame's writers:
 *   1. it writes `<dir>/reached`,
 *   2. it waits for `<dir>/release`, whose content is `commit` or `conflict`,
 *   3. `conflict` first moves the frame's deleted_at inside the same transaction, so the purge's own check
 *      refuses and rolls back; `commit` lets the purge run untouched.
 * The hold is one-shot (`armed` is removed), so the probe and every other transaction pass straight through.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { PGlite } from '@electric-sql/pglite'

const dir = process.env.DOOP_PURGE_HOLD_DIR

if (dir) {
  const armed = path.join(dir, 'armed')
  const reached = path.join(dir, 'reached')
  const release = path.join(dir, 'release')
  const original = PGlite.prototype.transaction

  PGlite.prototype.transaction = function (callback, ...rest) {
    return original.call(
      this,
      async (tx) => {
        const query = tx.query.bind(tx)
        let first = true
        tx.query = async (...args) => {
          if (first) {
            first = false
            if (/statement_timeout/.test(String(args[0])) && fs.existsSync(armed)) {
              const frameId = fs.readFileSync(armed, 'utf8').trim()
              fs.rmSync(armed)
              fs.writeFileSync(reached, frameId)
              while (!fs.existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20))
              if (fs.readFileSync(release, 'utf8').trim() === 'conflict')
                await query('update frames set deleted_at = deleted_at + 3 where id = $1', [frameId])
            }
          }
          return query(...args)
        }
        return callback(tx)
      },
      ...rest,
    )
  }
}
