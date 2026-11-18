// Migration base selection (CHE-7207 S2a). Runs first in the `lint` job (S2) and in every `test (N)` shard
// (S3b). Picks the revision the candidate's migrations are checked against, per caller event, and fails
// closed on anything it cannot prove. In a reusable workflow `github.event_name` is the caller's event.
//
//   pull_request       base = HEAD^1 of the merge ref        fetch --no-tags --depth=2 origin <HEAD>
//   push               base = github.event.before            fetch --no-tags --depth=1 origin <before>
//   workflow_dispatch  base = HEAD^1                         fetch --no-tags --depth=2 origin <HEAD>
//   any other          fail closed, no fetch
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { formatBaseMarker } from './migration-marker.mjs'

const run = promisify(execFile)
const SHA = /^[0-9a-f]{40}$/
const ZERO = /^0{40}$/
const no = (reason) => ({ ok: false, reason })

const realGit = {
  head: async () => (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  fetch: async (args) => void (await run('git', ['fetch', ...args])),
  parent: async (rev, n) => {
    try {
      return (await run('git', ['rev-parse', '--verify', '--quiet', `${rev}^${n}`])).stdout.trim() || null
    } catch {
      return null
    }
  },
  hasCommit: async (sha) => {
    try {
      await run('git', ['cat-file', '-e', `${sha}^{commit}`])
      return true
    } catch {
      return false
    }
  },
}

// `git` is injectable: { head(), fetch(args), parent(rev, n) -> sha | null, hasCommit(sha) }.
export async function selectBase({ event, candidate, payload, runAttempt, git = realGit }) {
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(event))
    return no(`event ${JSON.stringify(event)} has no base rule`)
  if (!/^\d+$/.test(String(runAttempt ?? ''))) return no('run_attempt is missing')
  if (!SHA.test(candidate ?? '')) return no('candidate (github.sha) is not a commit sha')
  const head = await git.head()
  if (head !== candidate) return no(`checked-out HEAD ${head} is not the candidate ${candidate}`)

  const fetch = async (args) => {
    try {
      await git.fetch(args)
      return null
    } catch (e) {
      return no(`fetch failed: ${e.message}`)
    }
  }

  let base
  let mergedHead = '-'
  let prHead = '-'
  const notes = []
  if (event === 'push') {
    const before = payload?.before
    if (typeof before !== 'string' || !SHA.test(before) || ZERO.test(before))
      return no('push before is empty, all zeros or not a commit sha')
    const failed = await fetch(['--no-tags', '--depth=1', 'origin', before])
    if (failed) return failed
    if (!(await git.hasCommit(before))) return no(`push before ${before} is not available after the fetch`)
    base = before
  } else {
    if (event === 'pull_request') {
      prHead = payload?.pull_request?.head?.sha
      if (typeof prHead !== 'string' || !SHA.test(prHead)) return no('pull_request payload has no pr_head sha')
      notes.push(`pull_request.base.sha=${payload.pull_request.base?.sha ?? '-'}`)
    }
    const failed = await fetch(['--no-tags', '--depth=2', 'origin', head])
    if (failed) return failed
    base = await git.parent(head, 1)
    if (!base) return no('HEAD has no first parent')
    if (event === 'pull_request') {
      mergedHead = await git.parent(head, 2)
      if (!mergedHead) return no('HEAD has no second parent, so merged_head is missing')
      if (mergedHead !== prHead) return no(`merged_head ${mergedHead} differs from pr_head ${prHead}`)
    }
  }
  if (!SHA.test(base) || ZERO.test(base)) return no('base is empty, all zeros or not a commit sha')
  if (base === head) return no('base equals HEAD')

  const attempt = String(runAttempt)
  return {
    ok: true,
    base,
    notes,
    marker: formatBaseMarker({ event, candidate, base, mergedHead, prHead, runAttempt: attempt }),
    env: {
      MIGRATION_BASE_SHA: base,
      MIGRATION_CANDIDATE: candidate,
      MIGRATION_PR_HEAD: prHead,
      MIGRATION_RUN_ATTEMPT: attempt,
    },
  }
}

async function cli(env) {
  const eventPath = env.GITHUB_EVENT_PATH
  const result = await selectBase({
    event: env.GITHUB_EVENT_NAME,
    candidate: env.GITHUB_SHA,
    payload: eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {},
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  })
  if (!result.ok) {
    console.log(`migration-base FAIL ${result.reason}`)
    return 1
  }
  if (env.GITHUB_ENV)
    appendFileSync(
      env.GITHUB_ENV,
      Object.entries(result.env)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
    )
  for (const n of result.notes) console.log(n)
  console.log(result.marker)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.log(`migration-base FAIL ${err.message}`)
      process.exit(1)
    },
  )
}
