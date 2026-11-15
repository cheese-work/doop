#!/usr/bin/env node
// The migration inventory sha (CHE-5544, plan CHE-5474 C-6): sha256 over every `*.sql` file name and bytes
// in the migrations directory, in name order, then the drizzle journal. D1 records it in the candidate
// manifest; D2's `admit` recomputes it from the checked-out candidate and refuses a difference.
// Usage: node scripts/migration-inventory.mjs [repo-root]   (default: the current directory)
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function inventorySha(root = '.') {
  const dir = join(root, 'server/db/migrations')
  const hash = createHash('sha256')
  const part = (label, bytes) => hash.update(`${label}\0${bytes.length}\0`).update(bytes)
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()
  for (const name of names) part(name, readFileSync(join(dir, name)))
  part('meta/_journal.json', readFileSync(join(dir, 'meta', '_journal.json'))) // throws when missing
  return hash.digest('hex')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(inventorySha(process.argv[2]))
}
