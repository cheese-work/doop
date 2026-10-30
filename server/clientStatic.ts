import path from 'node:path'
import compression from 'compression'
import express, { type Express } from 'express'

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

/* serve the built client; the SPA fallback sends every other GET to index.html */
export function serveClient(app: Express, dist: string): void {
  app.use(compression())
  /* Vite hashes /assets filenames, so they never change; index.html must revalidate to pick up a deploy */
  app.use(
    '/assets',
    express.static(path.join(dist, 'assets'), { maxAge: ONE_YEAR_SECONDS * 1000, immutable: true, index: false }),
  )
  app.use(express.static(dist, { maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }))
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(dist, 'index.html'))
  })
}
