// Release measurement for the upstream sync watch (CHE-7207 S9a). Pure: JSON in, JSON out, no I/O, no clock.
//
// input  { now, deadline, releases: [{tag, commit, published_at}],
//          prs: [{number, createdAt, mergedAt, closedAt?, contains: [commit]}]   (PRs to cheese/main only)
//          ledger_children: [{tag?, commit?}], seen_tags: {tag: {commit, published_at?, seen_at}},
//          read_errors: [string], after_tag?: string }
//          `releases` may hold older tags (v0.14.0): they supply the predecessor for M2.
//          `after_tag`: tags up to and including it are predecessors only, never measured.
// output { outcome: PENDING | ERROR | MISS | RECORDED | NOT-RUN, reason?, next_check?, next_check_ict?, tags: [...] }
//
// M1  hours from publication (else seen_at) to the createdAt of the first PR containing the tag commit.
// M1' diagnostic, burst only: that PR's createdAt minus the predecessor PR's mergedAt (0 when negative).
// M2  max(0, mergedAt of the PR that brought the predecessor - published_at); `ongoing` while it is unmerged.
//     At +72 h it is frozen at the checkpoint: the merge delay if merged by then, else 72 h and `ongoing`.
const H72 = 72 * 3600e3

const ms = (v) => (v == null ? NaN : Date.parse(v))
const iso = (n) => new Date(n).toISOString()
const ict = (n) => new Date(n + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' ICT'
const dur = (n) => {
  const minutes = Math.round(n / 60e3)
  return { minutes, text: `${Math.floor(minutes / 60)} h ${minutes % 60} min` }
}

export function measure(input) {
  const now = ms(input.now)
  const deadline = ms(input.deadline)
  const errors = [...(input.read_errors ?? [])]
  if (Number.isNaN(now)) errors.push('invalid now')
  const afterDeadline = now >= deadline // false when the deadline is missing: it then offers no wake candidate

  // Tags: releases win over seen_tags; the clock starts at published_at, else seen_at.
  const byTag = new Map()
  for (const [tag, s] of Object.entries(input.seen_tags ?? {}))
    byTag.set(tag, { tag, commit: s.commit, start: ms(s.published_at ?? s.seen_at) })
  for (const r of input.releases ?? []) byTag.set(r.tag, { tag: r.tag, commit: r.commit, start: ms(r.published_at) })
  const all = [...byTag.values()].filter((x) => !Number.isNaN(x.start)).sort((a, b) => a.start - b.start)
  const cut = input.after_tag ? all.findIndex((x) => x.tag === input.after_tag) + 1 : 0

  // A PR counts unless it was closed without merging. `covers(commit)` = the PRs containing it, oldest first.
  const live = (input.prs ?? []).filter((p) => p.mergedAt || !p.closedAt)
  const covers = (c) => live.filter((p) => p.contains?.includes(c)).sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
  const mergedOf = (c) => {
    const merged = covers(c).filter((p) => p.mergedAt)
    return merged.length ? Math.min(...merged.map((p) => ms(p.mergedAt))) : null
  }
  const admitted = (x) =>
    (input.ledger_children ?? []).some((c) => c.tag === x.tag || (c.commit && c.commit === x.commit))

  const tags = all.slice(cut).map((x) => {
    const i = all.indexOf(x)
    const prev = all[i - 1]
    const prs = covers(x.commit)
    const first = prs[0]
    const merged = mergedOf(x.commit)
    const checkpoint = x.start + H72
    const out = { tag: x.tag, commit: x.commit, published_at: iso(x.start), pr: first?.number ?? null }

    out.m1 = first
      ? dur(ms(first.createdAt) - x.start)
      : afterDeadline && admitted(x)
        ? { minutes: null, text: `no PR, open ${Math.round((now - x.start) / 3600e3)} h` }
        : null

    const prevMerged = prev ? mergedOf(prev.commit) : null
    const burst = prev && (prevMerged == null || prevMerged > x.start)
    const prevPr = prev ? covers(prev.commit)[0] : null
    out.m1_prime =
      burst && first && prevMerged != null && first !== prevPr
        ? dur(Math.max(0, ms(first.createdAt) - prevMerged))
        : null

    // The oldest tag has no predecessor to be behind.
    const m2 = prev
      ? { ...dur(Math.max(0, (prevMerged ?? now) - x.start)), ...(prevMerged == null ? { ongoing: true } : {}) }
      : dur(0)
    out.m2_at_publication = m2
    // The +72 h value is the state at the checkpoint, so a later merge or a delayed read never moves it:
    // merged by then, the merge delay; otherwise 72 h and still ongoing.
    out.m2_at_72h =
      now < checkpoint
        ? { pending_until: iso(checkpoint) }
        : prevMerged != null && prevMerged <= checkpoint
          ? m2
          : { ...dur(H72), ongoing: true }

    if (merged != null) {
      Object.assign(out, now < checkpoint ? { outcome: 'PENDING', pending_until: checkpoint } : { outcome: 'RECORDED' })
    } else if (!afterDeadline) {
      Object.assign(out, { outcome: 'PENDING', pending_until: deadline })
    } else {
      out.outcome = 'MISS'
      out.reason = first ? 'open sync' : admitted(x) ? 'no sync PR' : 'lost admission'
    }
    return out
  })

  const done = (o) => ({
    ...o,
    tags: tags.map(({ pending_until, ...t }) => ({
      ...t,
      ...(pending_until > 0 ? { pending_until: iso(pending_until) } : {}),
    })),
  })
  const result = (outcome, extra = {}) => done({ outcome, ...extra })

  if (errors.length) return result('ERROR', { reason: `read failed: ${errors.join('; ')}` })

  const pending = tags.filter((t) => t.outcome === 'PENDING')
  const noTags = tags.length === 0
  if (pending.length || (noTags && !afterDeadline)) {
    const times = pending.map((t) => t.pending_until)
    if (noTags) times.push(deadline)
    const future = times.filter((n) => n > now)
    if (!future.length) return result('ERROR', { reason: 'no future wake' })
    const next = Math.min(...future)
    return result('PENDING', { next_check: iso(next), next_check_ict: ict(next) })
  }
  if (tags.some((t) => t.outcome === 'MISS')) return result('MISS')
  if (noTags) return result('NOT-RUN')
  return result('RECORDED')
}
