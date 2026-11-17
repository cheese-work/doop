import { createHash } from 'node:crypto'
import { pageFrames } from '../shared/pages.ts'
import { RECON_DECISIONS, reconBodies } from '../shared/designCompleteness.ts'
import type { Canvas } from '../shared/types.ts'
import { expectedCells, hashScan, type ReconScan } from './reconScan.ts'
import type { WriteContext } from './writePolicy.ts'

/**
 * G2 (CHE-6078 r5): an agent on an issue's page may not create its first design frame until the recon
 * is complete. `checkReconGate` is the pure, synchronous judge `assertWritable` calls for `create_frame`;
 * it reads the recon frame (`doop-recon` JSON) from the canvas and the outside facts (image assets, the
 * issue's comments) from a cache that `warmReconEvidence` fills before the write, because the store is
 * synchronous and uploads and Multica are not. No cached fact = refused (fail closed).
 *
 * Limits, on purpose: the scan is the designer's own run of recon-scan (a reviewer re-runs it and
 * compares `scanHash`), and "locked" is the frame's `locked` flag until G5 makes locks hold.
 */

export type ReconComment = { agentId: string; at: number; body: string }
export type AssetFacts = { bytes: number; width: number; hash: string }
export type ReconSources = {
  assets?: (id: string) => Promise<AssetFacts | undefined>
  comments?: (issueId: string) => Promise<ReconComment[]>
}

/** What an uploaded image is: its size, and (PNG only: what a headless capture writes) its pixel width. */
export function assetFactsOf(buf: Buffer): AssetFacts {
  const png = buf.length >= 24 && buf.toString('latin1', 1, 4) === 'PNG' && buf.toString('latin1', 12, 16) === 'IHDR'
  return {
    bytes: buf.length,
    width: png ? buf.readUInt32BE(16) : 0,
    hash: createHash('sha256').update(buf).digest('hex'),
  }
}

/* a dynamic import keeps the database out of this module's load: only a real asset lookup needs it */
const storedAssets: ReconSources['assets'] = async (id) => {
  const asset = await (await import('./assets.ts')).getAsset(id)
  return asset ? assetFactsOf(asset.buf) : undefined
}

/** Comments come from Multica and are not plugged in yet (like the task verifier of G1): none = refused. */
let sources: ReconSources | undefined = { assets: storedAssets }
const assetCache = new Map<string, AssetFacts>()
const commentCache = new Map<string, ReconComment[]>()

export function setReconSources(next: ReconSources | undefined): void {
  sources = next
  assetCache.clear()
  commentCache.clear()
}

export const reconManifestHash = (body: string): string => createHash('sha256').update(body.trim()).digest('hex')
export const isReconHtml = (html: string): boolean => reconBodies(html).length > 0

type Cell = {
  screen?: string
  device?: number
  candidate?: string
  state?: string
  asset?: string | null
  na?: unknown
}
type Recon = {
  scanHash?: unknown
  mainSha?: unknown
  scan?: unknown
  candidates?: unknown
  matrix?: unknown
}
const cellKey = (c: Cell) => `${c.screen}|${c.device}|${c.candidate ?? ''}|${c.state ?? ''}`
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

function reconOf(canvas: Canvas, pageId: string) {
  return pageFrames(canvas, pageId).flatMap((frame) => {
    const body = reconBodies(frame.html)[0]
    return body === undefined ? [] : [{ frame, body }]
  })
}

/** Fetch what the sync check needs: the images the recon cites and the issue's comments. Never throws. */
export async function warmReconEvidence(canvas: Canvas, pageId: string, ctx: WriteContext): Promise<void> {
  if (ctx.kind !== 'agent' || !ctx.issueId || !sources) return
  const { assets, comments } = sources
  const ids = new Set<string>()
  for (const { body } of reconOf(canvas, pageId))
    try {
      for (const cell of (obj(JSON.parse(body)).matrix as Cell[] | undefined) ?? []) if (cell.asset) ids.add(cell.asset)
    } catch {
      /* the check reports an unreadable recon */
    }
  await Promise.all(
    [...ids]
      .filter((id) => !assetCache.has(id))
      .map(async (id) => {
        try {
          const facts = await assets?.(id)
          if (facts) assetCache.set(id, facts)
        } catch {
          /* unknown asset: refused by the check */
        }
      }),
  )
  try {
    const list = await comments?.(ctx.issueId)
    if (list) commentCache.set(ctx.issueId, list)
    else commentCache.delete(ctx.issueId)
  } catch {
    commentCache.delete(ctx.issueId)
  }
}

const SHOWN = 6

/** Why `ctx` may not yet create a design frame on `pageId`; empty = every G2 condition holds. */
export function checkReconGate(canvas: Canvas, pageId: string, ctx: WriteContext, now: number): string[] {
  const recons = reconOf(canvas, pageId)
  if (recons.length !== 1)
    return [recons.length ? 'the page has more than one recon frame' : 'the page has no recon frame (doop-recon)']
  const { frame, body } = recons[0]!
  let recon: Recon
  try {
    recon = obj(JSON.parse(body))
  } catch {
    return ['doop-recon is not valid JSON']
  }
  const scan = obj(recon.scan) as Partial<ReconScan>
  if (!Array.isArray(scan.screens) || !Array.isArray(scan.candidates) || !Array.isArray(recon.matrix))
    return ['doop-recon needs scan {screens, candidates} and a matrix list']
  const why: string[] = []
  const fullScan = scan as ReconScan

  /* 1. the scan is the one the recon names, and every candidate in it has a decision */
  if (hashScan(fullScan) !== recon.scanHash) why.push('the scan hash does not match the scan in doop-recon')
  const decisions = new Map(
    (Array.isArray(recon.candidates) ? recon.candidates : []).map((c) => [String(obj(c).id), obj(c)] as const),
  )
  for (const c of fullScan.candidates) {
    const d = decisions.get(c.id)
    const decision = String(d?.decision)
    if (!d || !(RECON_DECISIONS as readonly string[]).includes(decision)) why.push(`candidate ${c.id} has no decision`)
    else if (decision !== 'keep' && !String(d.reason ?? '').trim())
      why.push(`candidate ${c.id} is ${decision} without a reason`)
  }

  /* 2. every cell of the scan-derived matrix has a real image, or an n/a the scan proves */
  const given = new Map((recon.matrix as Cell[]).map((c) => [cellKey(c), c]))
  const byId = new Map(fullScan.candidates.map((c) => [c.id, c]))
  const seenImage = new Map<string, string>()
  let applicable = 0
  for (const want of expectedCells(fullScan)) {
    const cell = given.get(want.key)
    if (!cell) {
      why.push(`missing cell ${want.key}`)
      continue
    }
    if (cell.asset) {
      applicable++
      const facts = assetCache.get(cell.asset)
      if (!facts) why.push(`cell ${want.key}: image ${cell.asset} is not uploaded`)
      else if (facts.bytes <= 0) why.push(`cell ${want.key}: image ${cell.asset} is empty`)
      else if (facts.width !== want.device)
        why.push(`cell ${want.key}: image ${cell.asset} has width ${facts.width}px, the device is ${want.device}px`)
      else {
        const other = seenImage.get(facts.hash)
        if (other) why.push(`cell ${want.key} shows the same image as cell ${other}`)
        seenImage.set(facts.hash, want.key)
      }
      continue
    }
    const proof = obj(cell.na)
    const cand = want.candidate ? byId.get(want.candidate) : undefined
    const proven =
      cand?.devices !== undefined &&
      !cand.devices.includes(want.device) &&
      proof.file === cand.file &&
      proof.line === cand.line &&
      String(proof.reason ?? '').trim() !== ''
    if (!proven)
      why.push(`cell ${want.key} has no image, and its n/a is not proven by the scan (file:line, reason, device)`)
  }

  /* 3. the agent confirmed this exact recon on the issue before this write */
  const mine = (ctx.issueId ? (commentCache.get(ctx.issueId) ?? []) : []).filter(
    (c) => c.agentId === ctx.agentId && c.at < now,
  )
  const hash = reconManifestHash(body)
  const comment = mine.filter((c) => c.body.includes(`recon-manifest: sha256=${hash}`)).sort((a, b) => b.at - a.at)[0]
  if (!mine.length) why.push('the issue has no confirmation comment from this agent before this write')
  else if (!comment) why.push('no confirmation comment carries this recon’s manifest hash (recon-manifest: sha256=…)')
  else {
    if (!comment.body.includes(frame.id)) why.push(`the comment does not name the recon frame ${frame.id}`)
    const sha = /main-sha:\s*(\S+)/.exec(comment.body)?.[1]
    if (!sha || sha !== recon.mainSha) why.push(`main-sha in the comment (${sha ?? 'none'}) differs from doop-recon`)
    const images = Number(/recon-images:\s*(\d+)/.exec(comment.body)?.[1])
    if (images !== applicable) why.push(`recon-images in the comment (${images}) is not the ${applicable} imaged cells`)
  }

  /* 4. the recon frame is locked, so the inventory cannot be edited back */
  if (!frame.locked) why.push('the recon frame is not locked')
  return why
}

export function reconRefusal(reasons: string[]): string {
  const more = reasons.length - SHOWN
  return `recon gate: ${reasons.slice(0, SHOWN).join('; ')}${more > 0 ? `; +${more} more` : ''}`
}
