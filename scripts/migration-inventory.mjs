// Migration inventory (C-8.1, CHE-5474 S4a): the ordered `*.sql` files (name and bytes) plus
// `meta/_journal.json`, hashed into one manifest sha. D1 writes it into the candidate manifest; the
// deploy run recomputes it at the candidate SHA and stops on a mismatch.
// Fails closed: an unreadable directory or a missing journal throws.
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

export async function inventory(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()
  const migrations = []
  for (const name of names) migrations.push({ name, sha256: sha256(await readFile(path.join(dir, name))) })
  const journalSha256 = sha256(await readFile(path.join(dir, 'meta/_journal.json')))
  return { migrations, journalSha256, sha256: sha256(JSON.stringify({ migrations, journalSha256 })) }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(await inventory(process.argv[2] ?? 'server/db/migrations'), null, 2))
}
