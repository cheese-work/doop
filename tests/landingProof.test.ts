import { createHash } from 'node:crypto'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  verifyLanding,
  type LandingMultica,
  type LandingProof,
  type LandingRequest,
  type TrustedChecklist,
} from '../server/landingProof.ts'
import { PageFinishedError } from '../server/pageState.ts'
import { assertWritable, PolicyRefused, type WriteContext, type WriteTarget } from '../server/writePolicy.ts'
import type { Canvas } from '../shared/types.ts'

/* CHE-9672 (A5 landing S3c): verifyLanding rebuilds the close proof from Multica and the sent bytes, and
   `land_proposal` is a write op whose policy rule needs a proof that only verifyLanding makes. Inert: no
   caller yet (S3b). Multica is a fake; the trusted checklist is S3a's interface, injected. */

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const WATCHER = 'watcher-agent'
const OWNER = 'owner-user'
const ISSUE = 'topic-issue'
const PROJECT = 'proj-a'
const CANVAS = 'canvas-1'
const SOURCE_PAGE = 'che-5478'
const TOPIC = 'Lifecycle UI'
const DECISION = 'decision-1'
const WORKSPACE = 'ws-1'

const htmlA = '<p>frame a</p>'
const htmlB = '<p>frame b</p>'
const lockOf = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    provider: 'doop',
    canvas_or_project_id: CANVAS,
    page_id: SOURCE_PAGE,
    screens: [
      { screen: 'A', frame_id: 'fa', file: 'a.html', content_sha256: sha(htmlA) },
      { screen: 'B', frame_id: 'fb', file: 'b.html', content_sha256: sha(htmlB) },
    ],
    ...over,
  })
const pinOf = (lockJson: string) =>
  `Lock pin: repo=cheese-work/doop pr=39 sha=${'a'.repeat(40)} path=design/lifecycle-ui/approved/LOCK.json manifest=${sha(lockJson)} canvas=${CANVAS} page=${SOURCE_PAGE}`

type World = {
  req: LandingRequest
  checklist: TrustedChecklist
  decision: Record<string, unknown>
  members: Record<string, unknown>[]
  watcherId: string | undefined
  multica: LandingMultica
  trusted: Mock<LandingMultica['trustedChecklist']>
}

function world(over: { lockJson?: string; pin?: string } = {}): World {
  const lockJson = over.lockJson ?? lockOf()
  const pin = over.pin ?? pinOf(lockJson)
  const w: Omit<World, 'multica' | 'trusted'> & { multica?: LandingMultica; trusted?: World['trusted'] } = {
    req: {
      canvasId: CANVAS,
      topicIssueId: ISSUE,
      sourcePageId: SOURCE_PAGE,
      sourcePageName: TOPIC,
      closeDecisionId: DECISION,
      pin,
      lockJson,
      frames: [
        { frameId: 'fa', html: htmlA, contentSha256: sha(htmlA) },
        { frameId: 'fb', html: htmlB, contentSha256: sha(htmlB) },
      ],
    } satisfies LandingRequest,
    checklist: {
      link: { canvas: CANVAS, topic: TOPIC },
      decisionId: DECISION,
      pin,
      recordCommentId: 'comment-1',
    } satisfies TrustedChecklist,
    decision: {
      id: DECISION,
      kind: 'decision',
      status: 'answered',
      authority: 'human',
      asking_agent_id: WATCHER,
      issue_id: ISSUE,
      project_id: PROJECT,
      workspace_id: WORKSPACE,
      human_user_id: OWNER,
      withdrawn_at: null,
      ask: `Close the proposal?\n\n${pin}\n\nMore text.`,
      options: [{ label: 'close' }, { label: 'keep open' }],
      answer: {
        answered_by_user_id: OWNER,
        chosen_option_index: 0,
        content_snapshot: 'close',
        disclaimed_at: null,
      },
    } as Record<string, unknown>,
    members: [
      { user_id: OWNER, role: 'owner' },
      { user_id: 'someone', role: 'member' },
    ] as Record<string, unknown>[],
    watcherId: WATCHER as string | undefined,
  }
  w.trusted = vi.fn(async () => w.checklist)
  /* one object, mutated by the tests: the fake reads it live, so no copy is returned */
  w.multica = {
    get watcherId() {
      return w.watcherId
    },
    trustedChecklist: w.trusted,
    decision: async () => w.decision,
    members: async () => w.members,
  }
  return w as World
}

const refused = async (w: World) => {
  try {
    await verifyLanding(w.req, w.multica)
  } catch (error) {
    return (error as { code?: string }).code
  }
  return 'accepted'
}

describe('verifyLanding', () => {
  it('accepts the valid case and returns the proof ids', async () => {
    const w = world()
    const proof = await verifyLanding(w.req, w.multica)
    expect(proof).toMatchObject({
      canvasId: CANVAS,
      projectId: PROJECT,
      issueId: ISSUE,
      decisionId: DECISION,
      recordCommentId: 'comment-1',
      watcherId: WATCHER,
      sourcePageName: TOPIC,
    })
    expect(proof.pin).toBe(w.req.pin)
    expect(proof.frames).toEqual([
      { frameId: 'fa', contentSha256: sha(htmlA) },
      { frameId: 'fb', contentSha256: sha(htmlB) },
    ])
    expect(w.trusted).toHaveBeenCalledWith(ISSUE)
  })

  it('settings unset: proof_unavailable, and Multica is not asked', async () => {
    const w = world()
    w.watcherId = undefined
    expect(await refused(w)).toBe('proof_unavailable')
    expect(w.trusted).not.toHaveBeenCalled()
  })

  it('passes a trustedChecklist refusal through with its code', async () => {
    const w = world()
    w.trusted.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'watcher_mismatch' }))
    expect(await refused(w)).toBe('watcher_mismatch')
  })

  it('maps a transport failure to proof_unavailable', async () => {
    const a = world()
    a.trusted.mockRejectedValueOnce(new Error('boom'))
    expect(await refused(a)).toBe('proof_unavailable')
    const b = world()
    b.multica.decision = async () => {
      throw new Error('500')
    }
    expect(await refused(b)).toBe('proof_unavailable')
    const c = world()
    c.multica.members = async () => {
      throw new Error('500')
    }
    expect(await refused(c)).toBe('proof_unavailable')
  })

  it('an unrelated owner close on the same issue refuses: the request names another decision', async () => {
    const w = world()
    w.req = { ...w.req, closeDecisionId: 'decision-other' }
    w.decision = { ...w.decision, id: 'decision-other' }
    expect(await refused(w)).toBe('decision_mismatch')
  })

  it('a superseded checklist answered close refuses: the record now names a newer decision', async () => {
    const w = world()
    w.checklist = { ...w.checklist, decisionId: 'decision-newer' }
    expect(await refused(w)).toBe('decision_mismatch')
  })

  it('a pin that is not the record pin refuses', async () => {
    const w = world()
    w.req = { ...w.req, pin: w.req.pin.replace('pr=39', 'pr=40') }
    expect(await refused(w)).toBe('pin_mismatch')
  })

  it('the link must name the request canvas and the source page name', async () => {
    const a = world()
    a.checklist = { ...a.checklist, link: { ...a.checklist.link, canvas: 'canvas-2' } }
    expect(await refused(a)).toBe('link_mismatch')
    const b = world()
    b.checklist = { ...b.checklist, link: { ...b.checklist.link, topic: 'Other topic' } }
    expect(await refused(b)).toBe('link_mismatch')
  })

  const decisionCases: [string, (d: Record<string, unknown>) => Record<string, unknown>, string][] = [
    ['kind is not decision', (d) => ({ ...d, kind: 'approval' }), 'decision_kind'],
    ['status is open', (d) => ({ ...d, status: 'open' }), 'decision_not_answered'],
    ['no answer', (d) => ({ ...d, answer: null }), 'decision_not_answered'],
    ['withdrawn', (d) => ({ ...d, withdrawn_at: '2026-11-26T00:00:00Z' }), 'decision_withdrawn'],
    ['authority is not human', (d) => ({ ...d, authority: 'agent' }), 'decision_not_human'],
    ['asked by another agent', (d) => ({ ...d, asking_agent_id: 'agent-x' }), 'decision_not_watcher'],
    ['on another issue', (d) => ({ ...d, issue_id: 'other-issue' }), 'decision_wrong_issue'],
    [
      'chosen option is not close',
      (d) => ({ ...d, answer: { ...(d.answer as object), chosen_option_index: 1, content_snapshot: 'keep open' } }),
      'decision_not_close',
    ],
    [
      'content snapshot differs from the chosen label',
      (d) => ({ ...d, answer: { ...(d.answer as object), content_snapshot: 'Close' } }),
      'decision_not_close',
    ],
    [
      'text-only answer (no chosen option)',
      (d) => ({ ...d, answer: { ...(d.answer as object), chosen_option_index: null } }),
      'decision_not_close',
    ],
    [
      'disclaimed',
      (d) => ({ ...d, answer: { ...(d.answer as object), disclaimed_at: '2026-11-26T00:00:00Z' } }),
      'decision_disclaimed',
    ],
    [
      'answered by a user who is not the human',
      (d) => ({ ...d, answer: { ...(d.answer as object), answered_by_user_id: 'someone' } }),
      'decision_answerer',
    ],
  ]
  for (const [name, change, code] of decisionCases)
    it(`decision ${name} -> ${code}`, async () => {
      const w = world()
      w.decision = change(w.decision)
      expect(await refused(w)).toBe(code)
    })

  it('the human must be an owner in the member list', async () => {
    const a = world()
    a.members = [{ user_id: OWNER, role: 'admin' }]
    expect(await refused(a)).toBe('answerer_not_owner')
    const b = world()
    b.members = [{ user_id: 'someone', role: 'owner' }]
    expect(await refused(b)).toBe('answerer_not_owner')
  })

  it('options may arrive base64-encoded, as the list endpoint sends them', async () => {
    const w = world()
    w.decision = { ...w.decision, options: Buffer.from(JSON.stringify([{ label: 'close' }])).toString('base64') }
    expect(await refused(w)).toBe('accepted')
  })

  it('exactly one pin line in the decision text, equal to the record pin', async () => {
    const none = world()
    none.decision = { ...none.decision, ask: 'Close the proposal?' }
    expect(await refused(none)).toBe('pin_line_missing')
    const two = world()
    two.decision = { ...two.decision, ask: `${two.req.pin}\n${two.req.pin}` }
    expect(await refused(two)).toBe('pin_line_ambiguous')
    const other = world()
    other.decision = { ...other.decision, ask: other.req.pin.replace('pr=39', 'pr=41') }
    expect(await refused(other)).toBe('pin_line_mismatch')
  })

  it('the sent LOCK.json must hash to the pin manifest', async () => {
    const w = world()
    w.req = { ...w.req, lockJson: `${w.req.lockJson}\n` }
    expect(await refused(w)).toBe('manifest_mismatch')
  })

  it('LOCK.json canvas, page and frame set must equal the request', async () => {
    const cases: Record<string, string> = {
      canvas: lockOf({ canvas_or_project_id: 'canvas-9' }),
      page: lockOf({ page_id: 'other-page' }),
      missing: lockOf({ screens: [{ frame_id: 'fa', file: 'a', content_sha256: sha(htmlA) }] }),
      extra: lockOf({
        screens: [
          { frame_id: 'fa', file: 'a', content_sha256: sha(htmlA) },
          { frame_id: 'fb', file: 'b', content_sha256: sha(htmlB) },
          { frame_id: 'fc', file: 'c', content_sha256: sha('c') },
        ],
      }),
    }
    for (const [name, lockJson] of Object.entries(cases)) {
      const w = world({ lockJson })
      expect(await refused(w), name).toBe('lock_mismatch')
    }
    const notJson = world({ lockJson: 'not json' })
    expect(await refused(notJson)).toBe('lock_invalid')
  })

  it('a repeated frame id in the request refuses', async () => {
    const w = world()
    w.req = { ...w.req, frames: [...w.req.frames, w.req.frames[0]!] }
    expect(await refused(w)).toBe('lock_mismatch')
  })

  it('each frame hash must equal its LOCK.json entry and the SHA256 of its html', async () => {
    const entry = world()
    entry.req = {
      ...entry.req,
      frames: [{ ...entry.req.frames[0]!, contentSha256: sha('x') }, entry.req.frames[1]!],
    }
    expect(await refused(entry)).toBe('frame_hash_mismatch')
    const bytes = world()
    bytes.req = { ...bytes.req, frames: [{ ...bytes.req.frames[0]!, html: '<p>changed</p>' }, bytes.req.frames[1]!] }
    expect(await refused(bytes)).toBe('frame_hash_mismatch')
  })
})

/* ---- the land_proposal rule of assertWritable ---- */

const LEDGER = 'ledger'
function canvasOf(over: { projectId?: string | undefined; pages?: Canvas['pages']; id?: string } = {}): Canvas {
  return {
    id: over.id ?? CANVAS,
    name: 'c',
    ownerId: 'u',
    projectId: 'projectId' in over ? over.projectId : PROJECT,
    pages: over.pages ?? [
      { id: LEDGER, name: 'Ledger', ledger: true },
      { id: SOURCE_PAGE, name: TOPIC, issueId: ISSUE },
    ],
    frames: [],
  } as unknown as Canvas
}
const proofOf = async (): Promise<LandingProof> => {
  const w = world()
  return verifyLanding(w.req, w.multica)
}
const target = (canvas: Canvas, over: Partial<WriteTarget> = {}): WriteTarget => ({
  canvas,
  sourcePageId: SOURCE_PAGE,
  pageIds: [LEDGER],
  ...over,
})
const sys: WriteContext = { kind: 'system' }
const taskless: WriteContext = { kind: 'agent', origin: 'mcp' }

describe('assertWritable land_proposal', () => {
  it('refuses without a LandingProof, for every kind of context', async () => {
    const canvas = canvasOf()
    for (const ctx of [sys, taskless, { kind: 'user', userId: 'u' } as WriteContext])
      expect(() => assertWritable(ctx, 'land_proposal', target(canvas))).toThrow(PolicyRefused)
  })

  it('refuses a proof-shaped object that verifyLanding did not make', async () => {
    const real = await proofOf()
    const forged = { ...real } as LandingProof
    expect(() => assertWritable({ ...sys, landing: forged }, 'land_proposal', target(canvasOf()))).toThrow(
      PolicyRefused,
    )
  })

  it('passes with a proof: system context and a taskless MCP agent on a bound canvas', async () => {
    const landing = await proofOf()
    const canvas = canvasOf()
    expect(() => assertWritable({ ...sys, landing }, 'land_proposal', target(canvas))).not.toThrow()
    expect(() => assertWritable({ ...taskless, landing }, 'land_proposal', target(canvas))).not.toThrow()
  })

  it('refuses a proof from another project, or for another canvas', async () => {
    const landing = await proofOf()
    expect(() =>
      assertWritable({ ...taskless, landing }, 'land_proposal', target(canvasOf({ projectId: 'proj-b' }))),
    ).toThrow(PolicyRefused)
    expect(() =>
      assertWritable({ ...taskless, landing }, 'land_proposal', target(canvasOf({ projectId: undefined }))),
    ).toThrow(PolicyRefused)
    expect(() =>
      assertWritable({ ...taskless, landing }, 'land_proposal', target(canvasOf({ id: 'canvas-2' }))),
    ).toThrow(PolicyRefused)
  })

  it('refuses a source page bound to another issue; an unbound source page passes', async () => {
    const landing = await proofOf()
    const bound = canvasOf({
      pages: [
        { id: LEDGER, name: 'Ledger', ledger: true },
        { id: SOURCE_PAGE, name: TOPIC, issueId: 'other-issue' },
      ],
    })
    expect(() => assertWritable({ ...taskless, landing }, 'land_proposal', target(bound))).toThrow(PolicyRefused)
    const unbound = canvasOf({
      pages: [
        { id: LEDGER, name: 'Ledger', ledger: true },
        { id: SOURCE_PAGE, name: TOPIC },
      ],
    })
    expect(() => assertWritable({ ...taskless, landing }, 'land_proposal', target(unbound))).not.toThrow()
  })

  it('refuses a source page that is missing or is not the proof topic', async () => {
    const landing = await proofOf()
    const canvas = canvasOf()
    expect(() =>
      assertWritable({ ...taskless, landing }, 'land_proposal', target(canvas, { sourcePageId: 'nope' })),
    ).toThrow(PolicyRefused)
    const renamed = canvasOf({
      pages: [
        { id: LEDGER, name: 'Ledger', ledger: true },
        { id: SOURCE_PAGE, name: 'Another name', issueId: ISSUE },
      ],
    })
    expect(() => assertWritable({ ...taskless, landing }, 'land_proposal', target(renamed))).toThrow(PolicyRefused)
  })

  it('the destination is the current ledger page only', async () => {
    const landing = await proofOf()
    const canvas = canvasOf()
    expect(() =>
      assertWritable({ ...taskless, landing }, 'land_proposal', target(canvas, { pageIds: [SOURCE_PAGE] })),
    ).toThrow(PolicyRefused)
    expect(() => assertWritable({ ...taskless, landing }, 'land_proposal', target(canvas, { pageIds: [] }))).toThrow(
      PolicyRefused,
    )
    const noLedger = canvasOf({ pages: [{ id: SOURCE_PAGE, name: TOPIC, issueId: ISSUE }] })
    expect(() =>
      assertWritable({ ...taskless, landing }, 'land_proposal', target(noLedger, { pageIds: [SOURCE_PAGE] })),
    ).toThrow(PolicyRefused)
  })

  it('the page rule runs first: a Finished ledger page is refused with page_finished', async () => {
    const landing = await proofOf()
    const canvas = canvasOf({
      pages: [
        { id: LEDGER, name: 'Ledger', ledger: true, finished: { at: 1, by: 'u' } },
        { id: SOURCE_PAGE, name: TOPIC, issueId: ISSUE },
      ],
    })
    expect(() => assertWritable({ ...sys, landing }, 'land_proposal', target(canvas))).toThrow(PageFinishedError)
  })

  it('the lock rule runs first: a locked frame in the target is refused', async () => {
    const landing = await proofOf()
    const frame = { id: 'f1', name: 'f1', locked: true } as unknown as NonNullable<WriteTarget['frame']>
    expect(() => assertWritable({ ...sys, landing }, 'land_proposal', target(canvasOf(), { frame }))).toThrow(/locked/)
  })

  it('the same taskless context still cannot create a frame on the bound canvas', async () => {
    const landing = await proofOf()
    const canvas = canvasOf()
    expect(() =>
      assertWritable({ ...taskless, landing }, 'create_frame', { canvas, pageIds: [LEDGER], html: '<p/>' }),
    ).toThrow(/no Multica task/)
  })
})
