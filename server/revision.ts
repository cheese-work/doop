import { readFileSync } from 'node:fs'

/* The commit this image was built from, for /healthz (CHE-5550, plan CHE-5474 C-7.2). image.yml passes it as the
   DOOP_REVISION build arg and the Dockerfile writes it to /app/REVISION. Outside an image there is no such file. */
export const REVISION_FILE = '/app/REVISION'

export function readRevision(file: string = REVISION_FILE): string {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return /^[0-9a-f]{40}$/.test(text) ? text : 'unknown'
  } catch {
    return 'unknown'
  }
}
