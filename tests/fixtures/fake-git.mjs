#!/usr/bin/env node
// Fake `git` for the cutover tests (CHE-7207 S1d): only `ls-remote <url> <ref>`.
// FAKE_GIT_TAGS='{"v0.15.0":"<40-hex>"}' maps tags to commits; an unknown tag prints nothing.
const [cmd, , ref] = process.argv.slice(2)
if (cmd !== 'ls-remote') {
  process.stderr.write(`fake-git: unsupported: ${process.argv.slice(2).join(' ')}\n`)
  process.exit(2)
}
const tags = JSON.parse(process.env.FAKE_GIT_TAGS ?? '{}')
const tag = ref?.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')
if (tags[tag] && !ref.endsWith('^{}')) process.stdout.write(`${tags[tag]}\trefs/tags/${tag}\n`)
