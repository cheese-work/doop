#!/usr/bin/env node
// Fake `gh api` for the admit.mjs tests (CHE-7207 S1c). Answers only the 2 reads admit.mjs makes:
//   repos/<fork>/compare/<commit>...cheese/main -> {"status": $FAKE_GH_COMPARE}  ("ERROR" exits 1 with an HTTP 500)
//   repos/kgoedecke/doop/releases...            -> $FAKE_GH_RELEASES               ("ERROR" exits 1)
const url = process.argv.slice(2).find((a) => a.startsWith('repos/')) ?? ''
const env = process.env
if (url.includes('/compare/')) {
  const v = env.FAKE_GH_COMPARE ?? 'diverged'
  if (v === 'ERROR') {
    process.stderr.write('gh: HTTP 500\n')
    process.exit(1)
  }
  if (v === '404') {
    process.stderr.write('gh: Not Found (HTTP 404)\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({ status: v }) + '\n')
} else if (url.includes('/releases')) {
  if (env.FAKE_GH_RELEASES === 'ERROR') {
    process.stderr.write('gh: HTTP 500\n')
    process.exit(1)
  }
  process.stdout.write((env.FAKE_GH_RELEASES ?? '[]') + '\n')
} else {
  process.stderr.write(`fake gh: unsupported ${process.argv.slice(2).join(' ')}\n`)
  process.exit(2)
}
