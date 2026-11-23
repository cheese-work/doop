/* Rule 17 `near-duplicate-color` (CHE-9115 S7, plan r6): two rendered colors that differ, but by less than a person
   can tell apart: ΔE2000 over 0 and under 3. It measures the rendered colors, so a token and a literal count the same
   (Hallmark gate 48 reads literals only and measures no distance). A page color rule: it runs on the frames that
   rendered, and says how many that was, so an empty list is never read as a clean page.

   colorjs.io defaults `deltaE` to ΔE1976, which calls two blues 3.3 apart that ΔE2000 puts under 1: the method is set
   explicitly. Pure over the colors the collector saw. */

import Color from 'colorjs.io'
import type { FactColor, PageFinding } from './frameLint.ts'

/** Colors closer than this, and not equal, are near duplicates. */
export const NEAR_DUPLICATE_DELTA_E = 3
/** Distinct colors compared on one page, most used first. A page with more is cut, and the note says so. */
export const NEAR_DUPLICATE_COLOR_CAP = 600
/** ΔE2000 is at least |ΔL*| / 1.75 (the lightness weight S_L is at most 1.75), so a pair this far apart in L* cannot
 *  be under ΔE 3 and is never measured. */
const L_WINDOW = NEAR_DUPLICATE_DELTA_E * 1.75

export interface ColorFrame {
  frame_id: string
  colors: FactColor[]
  /** the collector cut this frame's colors at its cap: the frame is not counted as considered */
  colors_capped?: boolean
}

export interface ColorCheck {
  findings: PageFinding[]
  /** frames whose colors were compared, of `total` frames on the page */
  considered: number
  total: number
  /** what an empty list means, in words: how many frames it covers */
  note: string
}

/** ΔE2000 between two CSS colors. */
export function colorDistance(a: string, b: string): number {
  return new Color(a).deltaE(new Color(b), { method: '2000' })
}

interface Measured {
  hex: string
  lightness: number
  color: Color
  count: number
  frame_id: string
  selector: string
  doop_id?: string
}

/** An opaque color as hex, or null for a color that cannot be read or is not opaque (what it covers decides it). */
function parseOpaque(value: string): { hex: string; color: Color } | null {
  try {
    const color = new Color(value)
    if (color.alpha !== 1) return null
    return { hex: color.to('srgb').toString({ format: 'hex', collapse: false }).toUpperCase(), color }
  } catch {
    return null
  }
}

function measure(frames: readonly ColorFrame[]): { colors: Measured[]; cut: number } {
  const byHex = new Map<string, Measured>()
  for (const frame of frames) {
    for (const used of frame.colors) {
      const parsed = parseOpaque(used.value)
      if (!parsed) continue
      const seen = byHex.get(parsed.hex)
      if (seen) {
        seen.count += used.count
        continue
      }
      byHex.set(parsed.hex, {
        hex: parsed.hex,
        lightness: parsed.color.to('lab').coords[0] ?? 0,
        color: parsed.color,
        count: used.count,
        frame_id: frame.frame_id,
        selector: used.selector,
        ...(used.doop_id ? { doop_id: used.doop_id } : {}),
      })
    }
  }
  const all = [...byHex.values()]
  const kept =
    all.length > NEAR_DUPLICATE_COLOR_CAP
      ? [...all].sort((a, b) => b.count - a.count).slice(0, NEAR_DUPLICATE_COLOR_CAP)
      : all
  return { colors: kept, cut: all.length - kept.length }
}

const uses = (count: number): string => `${count} ${count === 1 ? 'use' : 'uses'}`

/** `a` is the minor color of a pair: used less, and on a tie the later hex. */
const isMinor = (a: Measured, b: Measured): boolean => (a.count !== b.count ? a.count < b.count : a.hex > b.hex)

export function nearDuplicateColors(frames: readonly ColorFrame[], total: number): ColorCheck {
  const counted = frames.filter((frame) => !frame.colors_capped)
  const considered = counted.length
  const complete = considered >= total
  const { colors, cut } = measure(counted)
  const sorted = [...colors].sort((a, b) => a.lightness - b.lightness)
  /** per minor color: its nearest more-used near neighbor */
  const nearest = new Map<Measured, { other: Measured; distance: number }>()
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    for (let j = i + 1; j < sorted.length && sorted[j]!.lightness - a.lightness < L_WINDOW; j++) {
      const b = sorted[j]!
      const distance = a.color.deltaE(b.color, { method: '2000' })
      if (!(distance > 0 && distance < NEAR_DUPLICATE_DELTA_E)) continue
      const [minor, major] = isMinor(a, b) ? [a, b] : [b, a]
      const best = nearest.get(minor)
      if (!best || distance < best.distance) nearest.set(minor, { other: major, distance })
    }
  }
  const scope = `considered ${considered} of ${total} frames`
  const findings: PageFinding[] = [...nearest]
    .sort(([a], [b]) => colors.indexOf(a) - colors.indexOf(b))
    .map(([minor, { other, distance }]) => ({
      frame_id: minor.frame_id,
      rule: 'near-duplicate-color',
      level: 'warn' as const,
      element: { ...(minor.doop_id ? { doop_id: minor.doop_id } : {}), selector: minor.selector },
      message: `${minor.hex} (${uses(minor.count)}) is ΔE ${distance.toFixed(2)} from ${other.hex} (${uses(other.count)}): use one color${complete ? '' : ` (${scope})`}`,
    }))
  const note = complete ? `checked all ${total} frames` : scope
  return { findings, considered, total, note: cut > 0 ? `${note}; ${cut} colors over the cap not compared` : note }
}
