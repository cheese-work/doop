import { useEffect, useState, type RefObject } from 'react'
import { useStore } from '../lib/store'
import { currentPageCanvas } from '../lib/pages'
import { framesToMount } from '../lib/frameCulling'

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id))

/** Ids of the frames that hold an iframe (see frameCulling). Recomputed on a
 *  camera move, a frame change or a selection change, but it only re-renders
 *  when a frame crosses the margin. */
export function useMountedFrames(stage: RefObject<HTMLElement | null>): ReadonlySet<string> | null {
  const [mounted, setMounted] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    function update() {
      const el = stage.current
      const s = useStore.getState()
      const frames = currentPageCanvas()?.frames
      if (!el || !frames) return
      const next = framesToMount(
        frames,
        s.viewport,
        { width: el.clientWidth, height: el.clientHeight },
        new Set(s.selectedIds),
      )
      setMounted((prev) => (prev && sameSet(prev, next) ? prev : next))
    }
    update()
    /* the store also churns on cursors and presence: only these fields matter */
    const unsub = useStore.subscribe((s, prev) => {
      if (
        s.viewport !== prev.viewport ||
        s.canvas !== prev.canvas ||
        s.activePageId !== prev.activePageId ||
        s.selectedIds !== prev.selectedIds
      )
        update()
    })
    window.addEventListener('resize', update)
    return () => {
      unsub()
      window.removeEventListener('resize', update)
    }
  }, [stage])
  return mounted
}
