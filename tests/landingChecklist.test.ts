import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MulticaConfig } from '../server/multicaRuns.ts'
import { trustedChecklist } from '../server/landingChecklist.ts'

/**
 * The trusted checklist read of the landing track (CHE-9448 S3a). Multica is a fake fetch that serves
 * `GET /api/issues/:id/comments` in pages: `?recent=N` gives the first page, and a page that has an
 * older one after it answers `X-Multica-Next-Before` / `X-Multica-Next-Before-Id` (the cursor names the
 * CLI prints for `issue comment list --recent N --full`). The last page has no cursor header, and the
 * request never carries `fold`, so a resolved thread is read whole.
 */

const FIXTURE = readFileSync(new URL('./fixtures/design_records_fixtures.txt', import.meta.url), 'utf8')
const section = (name: string): string => {
  const parts = FIXTURE.split(/^=== (.+)$/m)
  const at = parts.indexOf(name)
  if (at < 0) throw new Error(`fixture section ${name} missing`)
  return (parts[at + 1] ?? '').replace(/^\n/, '').replace(/\n$/, '')
}

const WATCHER = section('watcher-id').trim()
const OTHER = '11111111-2222-4333-8444-555555555555'
const ISSUE = '0197c1a2-0000-7000-8000-000000000001'
const CONFIG: MulticaConfig = {
  apiUrl: 'https://multica.test',
  token: 'tok',
  workspaceId: 'ws-1',
  webUrl: 'https://multica.test/cheese-work',
}

let seq = 0
interface Row {
  id: string
  author_type: string
  author_id: string
  content: string
  parent_id: string | null
  created_at: string
}
const row = (author: string, content: string, at: string, extra: Partial<Row> = {}): Row => ({
  id: `c-${String(++seq).padStart(4, '0')}`,
  author_type: 'agent',
  author_id: author,
  content,
  parent_id: null,
  created_at: at,
  ...extra,
})

const LINK = section('link')
const CHECKLIST = section('checklist')
const checklistBody = (ref: string, text: string, decision = 'dec-1') =>
  [
    `design-checklist:${ref}`,
    `digest: ${ref}`,
    `decision: ${decision}`,
    `text: ${JSON.stringify(text)}`,
    `pin: Lock pin: repo=cheese-work/doop pr=39 sha=${'a'.repeat(40)} path=design/x/approved/LOCK.json manifest=${'b'.repeat(64)} canvas=TgQKWNP_e3 page=che-5478`,
  ].join('\n')

interface Fake {
  fetch: typeof fetch
  urls: string[]
}
/** `pages[0]` is the newest page; `status` overrides the answer for a page index. */
function fake(pages: Row[][], status: Record<number, number> = {}): Fake {
  const urls: string[] = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    urls.push(`${url.pathname}${url.search}`)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok')
    expect(new Headers(init?.headers).get('X-Workspace-ID')).toBe('ws-1')
    const before = url.searchParams.get('before')
    const index = before === null ? 0 : Number(before.replace('cursor-', ''))
    if (status[index]) return new Response('boom', { status: status[index] })
    const page = pages[index]
    if (!page) return new Response('[]', { status: 200 })
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (index + 1 < pages.length) {
      headers.set('X-Multica-Next-Before', `cursor-${index + 1}`)
      headers.set('X-Multica-Next-Before-Id', `id-${index + 1}`)
    }
    return new Response(JSON.stringify(page), { status: 200, headers })
  }
  return { fetch: impl as typeof fetch, urls }
}

const run = (f: Fake, watcher: string | null = WATCHER) =>
  trustedChecklist(ISSUE, CONFIG, watcher ?? undefined, f.fetch)

describe('trustedChecklist', () => {
  it('returns the latest watcher checklist across two pages', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const old = row(WATCHER, checklistBody('1:aaaaaaaaaaaa', 'old'), '2026-11-20T02:00:00Z')
    const latest = row(WATCHER, checklistBody('2:bbbbbbbbbbbb', 'Sub-issues:\n- none', 'dec-2'), '2026-11-20T03:00:00Z')
    /* page 0 is the newest threads; the link and the old checklist sit on the older page */
    const f = fake([[latest], [link, old]])
    const res = await run(f)
    expect(res).toMatchObject({ ok: true, decisionId: 'dec-2', recordCommentId: latest.id })
    if (!res.ok) throw new Error('unreachable')
    expect(res.link).toMatchObject({ canvas: 'TgQKWNP_e3', topic: 'lifecycle-ui', issue: 'CHE-5478' })
    expect(res.pin).toMatch(/^Lock pin: repo=cheese-work\/doop pr=39 sha=a{40} /)
    expect(f.urls).toHaveLength(2)
    /* no folding: the request never asks for a folded list */
    expect(f.urls.every((u) => !u.includes('fold'))).toBe(true)
    expect(f.urls[0]).toMatch(/^\/api\/issues\/0197c1a2-0000-7000-8000-000000000001\/comments\?/)
    expect(f.urls[1]).toContain('before=cursor-1')
    expect(f.urls[1]).toContain('before_id=id-1')
  })

  it('reads the S2 fixture byte for byte', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const list = row(WATCHER, CHECKLIST, '2026-11-20T02:00:00Z')
    const res = await run(fake([[list, link]]))
    expect(res).toMatchObject({
      ok: true,
      decisionId: '60bc2630-6d17-4ef6-afb5-f19694cd827b',
      recordCommentId: list.id,
    })
    if (!res.ok) throw new Error('unreachable')
    expect(res.pin).toBe(
      'Lock pin: repo=cheese-work/doop pr=39 sha=572cc77a350a7eab9562ed40e272e69444b38c2f path=design/lifecycle-ui/approved/LOCK.json manifest=ec47cb36bcfd5ac930b1d38454f14d0ee9e1d6a60d4ae7f8b6fa4d7954c01e1d canvas=TgQKWNP_e3 page=che-5478',
    )
    /* the decision text the watcher asks carries the same pin line */
    expect(section('decision-text')).toContain(res.pin)
  })

  it('decodes a quoted multi-line field as records._dec does', async () => {
    /* the fixture's `text:` holds "Sub-issues:\n- none\nLinked PRs:\n- none" in JSON quotes */
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const list = row(WATCHER, CHECKLIST, '2026-11-20T02:00:00Z')
    const res = await run(fake([[link, list]]))
    if (!res.ok) throw new Error('unreachable')
    expect(res.text).toBe('Sub-issues:\n- none\nLinked PRs:\n- none')
    /* an unquoted value stays as written; a quote that is not JSON stays as written */
    const odd = row(WATCHER, `design-checklist:x\ndecision: d\npin: "not json\ntext: plain`, '2026-11-20T03:00:00Z')
    const res2 = await run(fake([[link, odd]]))
    expect(res2).toMatchObject({ ok: true, pin: '"not json', text: 'plain' })
  })

  it('ignores a checklist from another agent', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const mine = row(WATCHER, checklistBody('1:aaaaaaaaaaaa', 'mine', 'dec-mine'), '2026-11-20T02:00:00Z')
    const theirs = row(OTHER, checklistBody('2:bbbbbbbbbbbb', 'theirs', 'dec-theirs'), '2026-11-20T03:00:00Z')
    const res = await run(fake([[theirs, mine, link]]))
    expect(res).toMatchObject({ ok: true, decisionId: 'dec-mine', recordCommentId: mine.id })
  })

  it('refuses an unauthorized consistent chain (X link, X checklist) with watcher_mismatch', async () => {
    const link = row(OTHER, LINK, '2026-11-20T01:00:00Z')
    const list = row(OTHER, CHECKLIST, '2026-11-20T02:00:00Z')
    expect(await run(fake([[link, list]]))).toEqual({ ok: false, reason: 'watcher_mismatch' })
  })

  it('refuses a foreign link first, then the watcher link and checklist, with watcher_mismatch', async () => {
    const foreign = row(OTHER, LINK, '2026-11-20T01:00:00Z')
    const link = row(WATCHER, LINK, '2026-11-20T02:00:00Z')
    const list = row(WATCHER, CHECKLIST, '2026-11-20T03:00:00Z')
    /* comment order, not page order, decides which link is first */
    expect(await run(fake([[list], [link], [foreign]]))).toEqual({ ok: false, reason: 'watcher_mismatch' })
  })

  it('counts a link by a member as the first link too', async () => {
    const member = row(OTHER, LINK, '2026-11-20T01:00:00Z', { author_type: 'member' })
    const link = row(WATCHER, LINK, '2026-11-20T02:00:00Z')
    const list = row(WATCHER, CHECKLIST, '2026-11-20T03:00:00Z')
    expect(await run(fake([[member, link, list]]))).toEqual({ ok: false, reason: 'watcher_mismatch' })
  })

  it('refuses two watcher links on different canvases with link_conflict', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const other = row(WATCHER, LINK.replace('"canvas": "TgQKWNP_e3"', '"canvas": "Zzzzzzzzzz"'), '2026-11-20T02:00:00Z')
    const list = row(WATCHER, CHECKLIST, '2026-11-20T03:00:00Z')
    expect(await run(fake([[link, other, list]]))).toEqual({ ok: false, reason: 'link_conflict' })
  })

  it('accepts a repeated watcher link for the same canvas and topic', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const again = row(WATCHER, LINK, '2026-11-20T02:00:00Z')
    const list = row(WATCHER, CHECKLIST, '2026-11-20T03:00:00Z')
    expect((await run(fake([[link, again, list]]))).ok).toBe(true)
  })

  it('does not return a superseded checklist', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const old = row(WATCHER, checklistBody('1:aaaaaaaaaaaa', 'old', 'dec-old'), '2026-11-20T02:00:00Z')
    const latest = row(WATCHER, checklistBody('2:bbbbbbbbbbbb', 'new', 'dec-new'), '2026-11-20T03:00:00Z')
    const res = await run(fake([[latest, old, link]]))
    expect(res).toMatchObject({ ok: true, decisionId: 'dec-new', recordCommentId: latest.id })
    /* the latest one is the authority even when it is malformed: no fall back to the old one */
    const broken = row(WATCHER, 'design-checklist:3:cccccccccccc\ndigest: c', '2026-11-20T04:00:00Z')
    expect(await run(fake([[broken, latest, old, link]]))).toEqual({ ok: false, reason: 'proof_unavailable' })
  })

  it('orders comments by time, not by the order of the pages', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const a = row(WATCHER, checklistBody('1:aaaaaaaaaaaa', 'a', 'dec-a'), '2026-11-20T02:00:00.5Z')
    const b = row(WATCHER, checklistBody('2:bbbbbbbbbbbb', 'b', 'dec-b'), '2026-11-20T02:00:00.123456Z')
    /* a is later than b (.5 s against .123456 s) */
    expect(await run(fake([[b], [a], [link]]))).toMatchObject({ ok: true, decisionId: 'dec-a' })
  })

  it('answers no_checklist when the watcher wrote a link but no checklist', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const theirs = row(OTHER, CHECKLIST, '2026-11-20T02:00:00Z')
    expect(await run(fake([[link, theirs]]))).toEqual({ ok: false, reason: 'no_checklist' })
  })

  it('answers no_checklist when the issue has no link at all', async () => {
    expect(await run(fake([[]]))).toEqual({ ok: false, reason: 'no_checklist' })
  })

  it('refuses proof_unavailable on a 500 for the first page', async () => {
    expect(await run(fake([[]], { 0: 500 }))).toEqual({ ok: false, reason: 'proof_unavailable' })
  })

  it('refuses proof_unavailable on a 500 for a later page', async () => {
    const link = row(WATCHER, LINK, '2026-11-20T01:00:00Z')
    const list = row(WATCHER, CHECKLIST, '2026-11-20T02:00:00Z')
    expect(await run(fake([[list], [link]], { 1: 500 }))).toEqual({ ok: false, reason: 'proof_unavailable' })
  })

  it('refuses proof_unavailable when a page that the cursor names is missing', async () => {
    const list = row(WATCHER, CHECKLIST, '2026-11-20T02:00:00Z')
    const f = fake([[list], [], []])
    /* page 1 answers an empty list while a cursor still points past it: that page is unread */
    const impl = f.fetch
    const hole = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await impl(input, init)
      return new URL(String(input)).searchParams.get('before') === 'cursor-1' ? new Response('', { status: 404 }) : res
    }) as typeof fetch
    expect(await trustedChecklist(ISSUE, CONFIG, WATCHER, hole)).toEqual({ ok: false, reason: 'proof_unavailable' })
  })

  it('refuses proof_unavailable when the cursor does not move', async () => {
    const list = row(WATCHER, CHECKLIST, '2026-11-20T02:00:00Z')
    const stuck = (async () =>
      new Response(JSON.stringify([list]), {
        status: 200,
        headers: { 'X-Multica-Next-Before': 'same', 'X-Multica-Next-Before-Id': 'same' },
      })) as unknown as typeof fetch
    expect(await trustedChecklist(ISSUE, CONFIG, WATCHER, stuck)).toEqual({ ok: false, reason: 'proof_unavailable' })
  })

  it('refuses proof_unavailable on a half cursor, a bad payload, a network error and a bad timestamp', async () => {
    const list = row(WATCHER, CHECKLIST, '2026-11-20T02:00:00Z')
    const half = (async () =>
      new Response(JSON.stringify([list]), {
        status: 200,
        headers: { 'X-Multica-Next-Before': 'x' },
      })) as unknown as typeof fetch
    expect(await trustedChecklist(ISSUE, CONFIG, WATCHER, half)).toEqual({ ok: false, reason: 'proof_unavailable' })
    const notList = (async () => new Response('{"comments":[]}', { status: 200 })) as unknown as typeof fetch
    expect(await trustedChecklist(ISSUE, CONFIG, WATCHER, notList)).toEqual({ ok: false, reason: 'proof_unavailable' })
    const down = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(await trustedChecklist(ISSUE, CONFIG, WATCHER, down)).toEqual({ ok: false, reason: 'proof_unavailable' })
    const badTime = row(WATCHER, CHECKLIST, 'yesterday')
    expect(await run(fake([[badTime]]))).toEqual({ ok: false, reason: 'proof_unavailable' })
  })

  it('refuses proof_unavailable when the watcher id is unset, and does not ask Multica', async () => {
    const f = fake([[row(WATCHER, LINK, '2026-11-20T01:00:00Z')]])
    expect(await run(f, null)).toEqual({ ok: false, reason: 'proof_unavailable' })
    expect(await run(f, '')).toEqual({ ok: false, reason: 'proof_unavailable' })
    expect(f.urls).toEqual([])
  })

  it('refuses proof_unavailable on an unreadable link payload of the watcher', async () => {
    const bad = row(WATCHER, 'design-link:doop:x\njson: {not json', '2026-11-20T01:00:00Z')
    const list = row(WATCHER, CHECKLIST, '2026-11-20T02:00:00Z')
    expect(await run(fake([[bad, list]]))).toEqual({ ok: false, reason: 'proof_unavailable' })
  })
})
