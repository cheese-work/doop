// The predecessor's environment in the compat sandbox (CHE-5474 C-8.5c). Built from this list, never
// from the production env file or `process.env`: every other key in server/env.ts is absent.
import { randomBytes } from 'node:crypto'

export const ALLOWED_KEYS = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'CHATGPT_CONNECT_DISABLED',
  'DOOP_GEMINI_CLOUD_WORKERS',
]

export function buildPredecessorEnv({ databaseUrl, port = '4400', secret = randomBytes(32).toString('hex') }) {
  if (typeof databaseUrl !== 'string' || !databaseUrl) throw new Error('compat env: databaseUrl is required')
  return {
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: 'http://localhost',
    CHATGPT_CONNECT_DISABLED: '1',
    DOOP_GEMINI_CLOUD_WORKERS: '0',
  }
}

/** Exact match: an extra key is a leak, a missing one means the allowlist was not applied. */
export function checkEnvKeys(keys) {
  const have = new Set(keys)
  const extra = keys.filter((k) => !ALLOWED_KEYS.includes(k))
  const missing = ALLOWED_KEYS.filter((k) => !have.has(k))
  return { ok: extra.length === 0 && missing.length === 0, extra, missing }
}
