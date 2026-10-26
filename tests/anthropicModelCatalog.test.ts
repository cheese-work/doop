import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/**
 * A connected Claude API key's model menu comes from Anthropic's `/v1/models`,
 * asked with that key, so a model released after the curated list was written
 * is on the menu without a code change. These tests stand in a fake catalog
 * and pin: pagination, the filters, the curated-first merge, that a discovered
 * id can be chosen and then runs as itself, and the curated fallback when the
 * provider is down or rejects the key.
 */

const PAGE_ONE = {
  data: [
    {
      id: 'claude-sonnet-5',
      display_name: 'Claude Sonnet 5',
      created_at: '2026-05-01T00:00:00Z',
      max_tokens: 64000,
      capabilities: { image_input: { supported: true } },
      type: 'model',
    },
    {
      id: 'claude-opus-5-20260901',
      display_name: 'Claude Opus 5 (September)',
      created_at: '2026-09-01T00:00:00Z',
      max_tokens: 64000,
      capabilities: { image_input: { supported: true } },
      type: 'model',
    },
    /* text-only: out */
    {
      id: 'claude-ledger-5',
      display_name: 'Claude Ledger 5',
      created_at: '2026-08-01T00:00:00Z',
      max_tokens: 64000,
      capabilities: { image_input: { supported: false } },
      type: 'model',
    },
    /* too small an output window for a turn: out */
    {
      id: 'claude-haiku-4-5-20251001',
      display_name: 'Claude Haiku 4.5',
      created_at: '2025-10-01T00:00:00Z',
      max_tokens: 8192,
      capabilities: { image_input: { supported: true } },
      type: 'model',
    },
  ],
  has_more: true,
  first_id: 'claude-sonnet-5',
  last_id: 'claude-haiku-4-5-20251001',
}

const PAGE_TWO = {
  data: [
    {
      id: 'claude-fable-5-1',
      display_name: 'Claude Fable 5.1',
      created_at: '2026-10-01T00:00:00Z',
      max_tokens: 64000,
      capabilities: null,
      type: 'model',
    },
    /* not a Claude model id: out */
    { id: 'voyage-4', display_name: 'Voyage 4', created_at: '2026-01-01T00:00:00Z', max_tokens: null, type: 'model' },
  ],
  has_more: false,
  first_id: 'claude-fable-5-1',
  last_id: 'voyage-4',
}

let mode: 'catalog' | 'down' | 'rejects' = 'catalog'
const seenKeys: string[] = []
const seenPaths: string[] = []

let anthropic: http.Server
let server: Server
let alice: Client

beforeAll(async () => {
  anthropic = http.createServer((req, res) => {
    seenPaths.push(req.url ?? '')
    seenKeys.push(String(req.headers['x-api-key'] ?? ''))
    if (!req.url?.startsWith('/v1/models')) {
      res.writeHead(404).end()
      return
    }
    if (mode === 'down') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}')
      return
    }
    if (mode === 'rejects') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"type":"authentication_error"}}')
      return
    }
    const after = new URL(req.url, 'http://x').searchParams.get('after_id')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(after ? PAGE_TWO : PAGE_ONE))
  })
  await new Promise<void>((resolve) => anthropic.listen(0, '127.0.0.1', resolve))
  const port = (anthropic.address() as AddressInfo).port
  server = await startServer({
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    OPENAI_API_KEY: '',
    DATABASE_URL: '',
    SMTP_HOST: '',
  })
  alice = await new Client(server).signUp('catalog-alice@example.test', 'Alice')
}, 60000)

afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => anthropic.close(() => resolve()))
})

it('serves nothing until an account is connected', async () => {
  expect(await (await alice.get('/api/model-account/models')).json()).toEqual({ models: [], live: false })
})

it('lists the models the key can run, curated first, and lets a discovered one be chosen', async () => {
  const key = 'sk-ant-catalog-test-key'
  expect((await alice.post('/api/model-account/anthropic-key', { apiKey: key })).status).toBe(200)

  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(true)
  expect(catalog.error).toBeUndefined()
  expect(catalog.models.map((m: { id: string }) => m.id)).toEqual([
    /* curated entries the provider confirmed, in curated order */
    'claude-fable-5-1',
    'claude-sonnet-5',
    /* then what the provider has that the curated list does not, newest first */
    'claude-opus-5-20260901',
  ])
  const [fable, sonnet, opus] = catalog.models
  /* a curated entry keeps its own name and blurb and is flagged recommended */
  expect(fable).toMatchObject({ name: 'Fable 5.1', recommended: true, vision: true })
  expect(sonnet.blurb).not.toBe('')
  /* a discovered entry wears the provider's display name */
  expect(opus).toMatchObject({ name: 'Claude Opus 5 (September)', blurb: '', vision: true })
  expect(opus.recommended).toBeUndefined()
  /* the SDK paged through, with the connected key, and the key never came back */
  expect(seenPaths.some((p) => p.includes('after_id=claude-haiku-4-5-20251001'))).toBe(true)
  expect(seenKeys.every((k) => k === key)).toBe(true)
  expect(JSON.stringify(catalog)).not.toContain(key)

  /* choosing a discovered id runs as that id, not the curated default */
  expect((await alice.patch('/api/model-account', { model: 'claude-opus-5-20260901' })).status).toBe(200)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ model: 'claude-opus-5-20260901' })
  /* an id that is not shaped like a Claude model is still refused */
  expect((await alice.patch('/api/model-account', { model: 'gpt-5.6-sol' })).status).toBe(400)
  expect((await alice.patch('/api/model-account', { model: 'claude-' })).status).toBe(400)
})

it('falls back to the curated menu when the provider is down, and says so', async () => {
  mode = 'down'
  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(false)
  expect(catalog.error).toMatch(/could not load models from Claude API/i)
  expect(catalog.models.map((m: { id: string }) => m.id)).toContain('claude-sonnet-5')
  expect(catalog.models.every((m: { recommended?: boolean }) => m.recommended === undefined)).toBe(true)
})

it('tells the user to reconnect when the provider rejects the key', async () => {
  mode = 'rejects'
  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(false)
  expect(catalog.error).toMatch(/rejected the connected key/i)
})

it('keeps the curated menu for providers without a catalog', async () => {
  mode = 'catalog'
  const pathsBefore = seenPaths.length
  await alice.post('/api/model-account/openai-key', { apiKey: 'sk-openai-test' })
  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(false)
  expect(catalog.error).toBeUndefined()
  expect(catalog.models.map((m: { id: string }) => m.id)).toContain('gpt-5.6-terra')
  expect(seenPaths.length).toBe(pathsBefore)
})
