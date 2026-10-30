import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveClient } from '../server/clientStatic.ts'

let dist: string
let server: http.Server
let base: string

beforeAll(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-dist-'))
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'index.html'), `<html>${'x'.repeat(4000)}</html>`)
  fs.writeFileSync(path.join(dist, 'assets', 'index-ABC123.js'), `console.log("${'a'.repeat(50_000)}")`)
  const app = express()
  serveClient(app, dist)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dist, { recursive: true, force: true })
})

describe('serveClient', () => {
  it('compresses the hashed bundle when the client accepts gzip', async () => {
    const res = await fetch(`${base}/assets/index-ABC123.js`, { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  it('caches hashed assets as immutable for a year', async () => {
    const res = await fetch(`${base}/assets/index-ABC123.js`)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('never caches index.html, so a deploy is picked up at once', async () => {
    const res = await fetch(`${base}/c/MJ4yJPTHt6`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/no-cache/)
  })
})
