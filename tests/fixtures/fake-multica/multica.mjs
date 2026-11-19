#!/usr/bin/env node
// Fake `multica` CLI for the upstream-watch tests (CHE-7207 S1a).
// State lives in the JSON file $FAKE_MULTICA_STATE. Every call takes a file lock, so
// concurrent callers serialize. Fault injection: FAKE_MULTICA_FAULT="N:kind[,N:kind]",
// where N is the absolute call number kept in the state and kind is one of
//   crash        exit 1 before the call is applied
//   crash-after  apply the call, then exit 1 (the response is lost)
//   conflict     a concurrent writer bumps the target issue's revision first
//   kill         SIGKILL the caller (our parent) before the call is applied
//   kill-after   apply the call, then SIGKILL the caller
// Only what the upstream-watch scripts use is covered; anything else exits 2.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

const STATE = process.env.FAKE_MULTICA_STATE
if (!STATE) fail('FAKE_MULTICA_STATE is not set', 2)

function fail(msg, code = 1) {
  process.stderr.write(`fake-multica: ${msg}\n`)
  process.exit(code)
}
class Err extends Error {}

/* ---- args ---- */
const BOOL = new Set(['no-start', 'include-closed', 'resolve-thread'])
const REPEAT = new Set(['property'])
function parse(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) pos.push(a)
    else {
      const k = a.slice(2)
      const v = BOOL.has(k) ? true : argv[++i]
      if (REPEAT.has(k)) (flags[k] ??= []).push(v)
      else flags[k] = v
    }
  }
  return { pos, flags }
}

/* ---- lock + state ---- */
const LOCK = `${STATE}.lock`
function lock() {
  const t0 = Date.now()
  for (;;) {
    try {
      closeSync(openSync(LOCK, 'wx'))
      return
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 5000) unlinkSync(LOCK) // stale: holder was killed
      } catch {
        // the holder just released it
      }
      if (Date.now() - t0 > 20000) fail('lock timeout')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}
const unlock = () => {
  try {
    unlinkSync(LOCK)
  } catch {
    // already gone
  }
}
const load = () => {
  const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
  return { calls: 0, nextNumber: 8000, issues: [], autopilots: {}, wakeups: [], ...s }
}
const save = (s) => {
  writeFileSync(`${STATE}.tmp`, JSON.stringify(s, null, 2))
  renameSync(`${STATE}.tmp`, STATE)
}
const sha256 = (x) => createHash('sha256').update(x).digest('hex')

/* ---- handlers ---- */
const find = (s, ref) => s.issues.find((i) => i.id === ref || i.identifier === ref)
const need = (s, ref) => find(s, ref) ?? fail(`issue not found: ${ref}`)
const touch = (i) => void (i.revision = (i.revision ?? 1) + 1)
const text = (f) => (f['description-file'] ? readFileSync(f['description-file'], 'utf8') : f.description)

function issueCmd(s, sub, pos, f) {
  switch (sub) {
    case 'get':
      return need(s, pos[0])
    case 'children': {
      const parent = need(s, pos[0])
      const kids = s.issues.filter((i) => i.parent_issue_id === parent.id)
      const stages = [...new Set(kids.map((k) => k.stage ?? 0))].sort((a, b) => a - b)
      return {
        stages: stages.map((st) => {
          const issues = kids.filter((k) => (k.stage ?? 0) === st)
          return { stage: st, total: issues.length, done: issues.filter((k) => k.status === 'done').length, issues }
        }),
      }
    }
    case 'search': {
      const q = pos.join(' ').toLowerCase()
      const open = (i) => f['include-closed'] || !['done', 'cancelled'].includes(i.status)
      return { issues: s.issues.filter((i) => open(i) && (i.title ?? '').toLowerCase().includes(q)) }
    }
    case 'create': {
      const parent = f.parent ? need(s, f.parent) : null
      const number = s.nextNumber++
      const props = Object.fromEntries(
        (f.property ?? []).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]),
      )
      const issue = {
        id: `fake-${number}`,
        identifier: `CHE-${number}`,
        number,
        title: f.title,
        description: text(f) ?? '',
        status: f.status ?? 'todo',
        priority: f.priority ?? null,
        assignee_id: f['assignee-id'] ?? f.assignee ?? null,
        project_id: f.project ?? null,
        parent_issue_id: parent?.id ?? null,
        stage: f.stage ? Number(f.stage) : 0,
        properties: props,
        metadata: {},
        comments: [],
        duplicate_of: null,
        revision: 1,
      }
      s.issues.push(issue)
      return issue
    }
    case 'update': {
      const i = need(s, pos[0])
      if (f['expected-revision'] !== undefined && Number(f['expected-revision']) !== i.revision) {
        throw new Err(`conflict: revision is ${i.revision}, expected ${f['expected-revision']}`)
      }
      for (const [k, key] of [
        ['title', 'title'],
        ['status', 'status'],
        ['priority', 'priority'],
        ['assignee', 'assignee_id'],
      ]) {
        if (f[k] !== undefined) i[key] = f[k]
      }
      if (text(f) !== undefined) i.description = text(f)
      if (f.parent !== undefined) i.parent_issue_id = f.parent === '' ? null : need(s, f.parent).id
      touch(i)
      return i
    }
    case 'status': {
      const i = need(s, pos[0])
      if (f['duplicate-of'] !== undefined && pos[1] !== 'cancelled')
        throw new Err('--duplicate-of needs status cancelled')
      i.status = pos[1]
      if (f['duplicate-of'] !== undefined) i.duplicate_of = f['duplicate-of']
      touch(i)
      return i
    }
    case 'assign': {
      const i = need(s, pos[0])
      i.assignee_id = f['to-id'] ?? f.to
      touch(i)
      return i
    }
    case 'comment': {
      if (pos[0] !== 'add') break
      const i = need(s, pos[1])
      const content = f['content-file'] ? readFileSync(f['content-file'], 'utf8') : f.content
      const c = { id: `cm-${s.calls}`, content }
      ;(i.comments ??= []).push(c)
      return c
    }
    case 'metadata': {
      if (pos[0] !== 'set') break
      const i = need(s, pos[1])
      let v = f.value
      if (f.type !== 'string') {
        try {
          v = JSON.parse(v)
        } catch {
          // not JSON: keep the raw string
        }
      }
      ;(i.metadata ??= {})[f.key] = v
      touch(i)
      return i
    }
    case 'wakeup': {
      if (pos[0] !== 'create') break
      const w = { id: `wk-${s.calls}`, issue: need(s, pos[1]).id, flags: f }
      s.wakeups.push(w)
      return w
    }
  }
  throw new Err(`unsupported: issue ${sub} ${pos.join(' ')}`)
}

function autopilotCmd(s, sub, pos, f) {
  const ap = () => s.autopilots[pos[0]] ?? fail(`autopilot not found: ${pos[0]}`)
  const bump = (a) =>
    void (a.updated_at = new Date(Date.parse(a.updated_at ?? '2026-11-18T04:15:51Z') + 1000)
      .toISOString()
      .replace('.000Z', 'Z'))
  switch (sub) {
    case 'get':
      return { autopilot: ap() }
    case 'update': {
      const a = ap()
      if (f['if-description-sha256'] !== undefined && sha256(a.description ?? '') !== f['if-description-sha256']) {
        throw new Err('conflict: description hash mismatch')
      }
      for (const k of ['title', 'description', 'status', 'mode', 'project']) if (f[k] !== undefined) a[k] = f[k]
      bump(a)
      return { autopilot: a }
    }
    case 'create': {
      const id = `fake-ap-${s.calls}`
      const a = {
        id,
        title: f.title,
        description: f.description ?? '',
        status: 'active',
        mode: f.mode,
        agent: f.agent,
        project: f.project,
        updated_at: '2026-11-18T04:15:51Z',
        triggers: [],
        runs: [],
      }
      s.autopilots[id] = a
      return { autopilot: a }
    }
    case 'trigger-add': {
      const a = ap()
      const t = { id: `tr-${s.calls}`, kind: f.kind ?? 'schedule', cron: f.cron, timezone: f.timezone ?? 'UTC' }
      a.triggers.push(t)
      return t
    }
    case 'runs': {
      const off = Number(f.offset ?? 0)
      return { runs: ap().runs.slice(off, off + Number(f.limit ?? 20)) }
    }
  }
  throw new Err(`unsupported: autopilot ${sub}`)
}

/* ---- main ---- */
const { pos, flags } = parse(process.argv.slice(2))
const [group, sub, ...rest] = pos
const faults = Object.fromEntries(
  (process.env.FAKE_MULTICA_FAULT ?? '')
    .split(',')
    .filter(Boolean)
    .map((x) => x.split(':')),
)
const killCaller = () => process.kill(process.ppid, 'SIGKILL')

lock()
const s = load()
const fault = faults[++s.calls]
let out
let error
try {
  if (fault === 'crash') throw new Err('injected crash')
  if (fault === 'kill') {
    save(s)
    unlock()
    killCaller()
    process.exit(137)
  }
  if (fault === 'conflict' && group === 'issue' && sub === 'update') touch(need(s, rest[0]))
  out =
    group === 'issue'
      ? issueCmd(s, sub, rest, flags)
      : group === 'autopilot'
        ? autopilotCmd(s, sub, rest, flags)
        : fail(`unsupported: ${group}`, 2)
} catch (e) {
  if (!(e instanceof Err)) throw e
  error = e
}
save(s)
unlock()
if (error) fail(error.message)
if (fault === 'crash-after') fail('injected crash after the call was applied')
if (fault === 'kill-after') {
  killCaller()
  process.exit(137)
}
process.stdout.write(JSON.stringify(out) + '\n')
