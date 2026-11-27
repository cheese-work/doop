import { afterAll, beforeAll, expect, it } from 'vitest'
import { multicaWebBase } from '../shared/multica.ts'
import { Client, startServer, type Server } from './harness.ts'

/* CHE-9396: the comments panel links a `Moved to Multica` key to the workspace
   the server is configured for. The URL travels on /api/me, the config the
   SPA already loads after sign-in. */

let configured: Server
let bare: Server

beforeAll(async () => {
  configured = await startServer({ MULTICA_WEB_URL: 'https://multica.test/cheese-work/' })
  bare = await startServer()
}, 90_000)

afterAll(async () => {
  await configured?.stop()
  await bare?.stop()
})

it('GET /api/me carries the configured Multica web URL without a trailing slash', async () => {
  const alice = await new Client(configured).signUp('alice-multica-url@test.dev', 'Alice Url')
  expect((await (await alice.get('/api/me')).json()).multicaWebUrl).toBe('https://multica.test/cheese-work')
})

it('GET /api/me omits it when the server has none', async () => {
  const bob = await new Client(bare).signUp('bob-multica-url@test.dev', 'Bob Url')
  expect((await (await bob.get('/api/me')).json()).multicaWebUrl).toBeUndefined()
})

it('multicaWebBase keeps only an http(s) URL and strips trailing slashes', () => {
  expect(multicaWebBase('https://m.example/w//')).toBe('https://m.example/w')
  expect(multicaWebBase('http://localhost:3000')).toBe('http://localhost:3000')
  expect(multicaWebBase('javascript:alert(1)')).toBeNull()
  expect(multicaWebBase('m.example/w')).toBeNull()
  expect(multicaWebBase(undefined)).toBeNull()
  expect(multicaWebBase('')).toBeNull()
})
