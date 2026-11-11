#!/usr/bin/env node
// Writes the image-publish evidence file: node scripts/image-evidence.mjs <out.json>
// Inputs (env): IMAGE, DIGEST, SHA, RUN_URL. Exits non-zero on any malformed value so a
// failed or tag-only push can never leave behind evidence that looks like a success.
import { writeFileSync } from 'node:fs'

const { IMAGE, DIGEST, SHA, RUN_URL } = process.env
const out = process.argv[2]

if (!out) throw new Error('usage: image-evidence.mjs <out.json>')
if (!IMAGE) throw new Error('IMAGE is required')
if (!/^sha256:[0-9a-f]{64}$/.test(DIGEST ?? '')) throw new Error(`DIGEST is not a sha256 digest: "${DIGEST}"`)
if (!/^[0-9a-f]{40}$/.test(SHA ?? '')) throw new Error(`SHA is not a full commit SHA: "${SHA}"`)
if (!/^https:\/\//.test(RUN_URL ?? '')) throw new Error(`RUN_URL is not an https URL: "${RUN_URL}"`)

const evidence = { image: IMAGE, digest: DIGEST, ref: `${IMAGE}@${DIGEST}`, sha: SHA, run_url: RUN_URL }
writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`)
