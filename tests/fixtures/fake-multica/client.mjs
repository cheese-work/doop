// Synchronous in-process wrapper: fakeCli(statePath)(['issue', 'get', id]) -> parsed JSON.
// Throws on a non-zero exit, with the fake's stderr as the message.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('./multica.mjs', import.meta.url))

export const fakeCli =
  (state, env = {}) =>
  (args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, FAKE_MULTICA_STATE: state, ...env },
      encoding: 'utf8',
    })
    if (r.status !== 0) throw new Error(r.stderr.trim() || `fake multica exited ${r.status}`)
    return r.stdout.trim() ? JSON.parse(r.stdout) : null
  }
