#!/usr/bin/env node
// Writes the candidate manifest D1 (image.yml) hands to D2 (cd-deploy.yml): node scripts/image-evidence.mjs <out.json>
// Inputs (env): IMAGE, DIGEST, SHA, RUN_URL, INVENTORY_SHA (scripts/migration-inventory.mjs), D1_RUN_ID.
// Exits non-zero on any malformed value so a failed or tag-only push can never leave behind a manifest
// that looks like a success.
import { writeFileSync } from 'node:fs'

const { IMAGE, DIGEST, SHA, RUN_URL, INVENTORY_SHA, D1_RUN_ID } = process.env
const out = process.argv[2]

if (!out) throw new Error('usage: image-evidence.mjs <out.json>')
if (!IMAGE) throw new Error('IMAGE is required')
if (!/^sha256:[0-9a-f]{64}$/.test(DIGEST ?? '')) throw new Error(`DIGEST is not a sha256 digest: "${DIGEST}"`)
if (!/^[0-9a-f]{40}$/.test(SHA ?? '')) throw new Error(`SHA is not a full commit SHA: "${SHA}"`)
if (!/^https:\/\//.test(RUN_URL ?? '')) throw new Error(`RUN_URL is not an https URL: "${RUN_URL}"`)
if (!/^[0-9a-f]{64}$/.test(INVENTORY_SHA ?? ''))
  throw new Error(`INVENTORY_SHA is not a sha256 hex: "${INVENTORY_SHA}"`)
if (!/^[0-9]+$/.test(D1_RUN_ID ?? '')) throw new Error(`D1_RUN_ID is not a run id: "${D1_RUN_ID}"`)

const manifest = {
  image: IMAGE,
  digest: DIGEST,
  ref: `${IMAGE}@${DIGEST}`,
  sha: SHA,
  run_url: RUN_URL,
  migration_inventory_sha: INVENTORY_SHA,
  d1_run_id: D1_RUN_ID,
}
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
