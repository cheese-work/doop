#!/usr/bin/env node
// Fake admit.mjs for the cutover tests (CHE-7207 S1d); the real one is S1c.
// Appends {dry, ledger} to `${FAKE_MULTICA_STATE}.admit.log`. A live run files one ledger child
// for FAKE_ADMIT_TAG (X.Y.Z) when none exists, through the fake CLI. FAKE_ADMIT_FAIL=dry|live
// makes that mode exit 1.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry-run')
const ledger = argv[argv.indexOf('--ledger') + 1]
appendFileSync(`${process.env.FAKE_MULTICA_STATE}.admit.log`, JSON.stringify({ dry, ledger }) + '\n')
if (process.env.FAKE_ADMIT_FAIL === (dry ? 'dry' : 'live')) {
  process.stderr.write('fake-admit: injected failure\n')
  process.exit(1)
}
const cli = (a) => JSON.parse(execFileSync(process.env.MULTICA_CLI_PATH, a, { encoding: 'utf8' }) || 'null')
const actions = []
const v = process.env.FAKE_ADMIT_TAG
if (v && !dry) {
  const kids = cli(['issue', 'children', ledger]).stages.flatMap((s) => s.issues)
  const title = `task(doop): merge upstream doop ${v} into cheese/main`
  if (!kids.some((k) => k.title === title)) {
    cli([
      'issue',
      'create',
      '--title',
      title,
      '--parent',
      ledger,
      '--status',
      'todo',
      '--description',
      `Upstream: kgoedecke/doop v${v} commit ${'c'.repeat(40)}`,
    ])
    actions.push({ type: 'create', version: v })
  }
}
process.stdout.write(JSON.stringify({ dry, actions }) + '\n')
