import type { Frame } from '../../shared/types'
import { useStore } from './store'
import { api, errorMessage } from './api'
import { requestFrame } from './frameBridge'
import { deleteFramesTracked, recordUpdate, recordUpdates, trackSave } from './history'
import {
  duplicateElement,
  isElementHidden,
  isElementLocked,
  moveElement,
  removeElement,
  replaceElement,
  setElementHidden,
  setElementLocked,
  shiftElement,
  type DropTarget,
  type FlowPlacement,
  type MovedElement,
} from './layers'

/* ---- element edits shared by the Layers rail and the element panel ---- */

export function saveFrameHtml(frame: Frame, html: string) {
  // Layer commands each need their own undo step, even when invoked rapidly.
  recordUpdate(frame.id, { html: frame.html }, { html }, true)
  useStore.getState().patchFrameLocal(frame.id, { html })
  trackSave(api.updateFrame(frame.id, { html }).catch(console.error))
}

/* ---- locks ---- */

/** A locked layer, or one inside a locked box, takes no edits from the stage
 *  or the rail: it can be selected in the Layers panel (so it can be
 *  unlocked) and nothing else. */
export function isLayerLocked(frame: Frame, selector: string): boolean {
  return !!frame.locked || isElementLocked(frame.html, selector)
}

/** Set or clear the element's own lock; false when the selector no longer
 *  resolves. The live document gets the attribute as well: FrameView
 *  withholds html from a frame in text-edit mode, and that mode's next save
 *  serializes the live document — without the attribute there, the save
 *  would silently drop the lock. */
export function setLayerLocked(frame: Frame, selector: string, locked: boolean): boolean {
  const html = setElementLocked(frame.html, selector, locked)
  if (html === null) return false
  saveFrameHtml(frame, html)
  void requestFrame(frame.id, 'doop:lock', { selector, locked })
  return true
}

/** Lock or unlock frames together, as one undo step. Frames already in the
 *  wanted state are left alone. */
export function setFramesLocked(frames: Frame[], locked: boolean) {
  const changed = frames.filter((f) => !!f.locked !== locked)
  if (!changed.length) return
  recordUpdates(changed.map((f) => ({ frameId: f.id, before: { locked: !!f.locked }, after: { locked } })))
  const store = useStore.getState()
  for (const f of changed) {
    store.patchFrameLocal(f.id, { locked })
    /* as for the eye: undo waits for the save, and a save the server refused
       is rolled back so the lock shows what everyone else sees */
    trackSave(
      api.updateFrame(f.id, { locked }).catch((err: unknown) => {
        const s = useStore.getState()
        s.patchFrameLocal(f.id, { locked: !locked })
        s.pushNotice(errorMessage(err, `Couldn’t ${locked ? 'lock' : 'unlock'} “${f.name}”`))
      }),
    )
  }
}

/** ⌘⇧L: a picked layer toggles its own lock; otherwise the selected frames
 *  lock together, and only unlock once every one of them is locked (a mixed
 *  selection locks the rest first, as Figma does). False when nothing is
 *  selected. */
export function toggleLockSelection(): boolean {
  const s = useStore.getState()
  const frames = s.canvas?.frames ?? []
  const picked = s.selectedElement
  if (picked) {
    const frame = frames.find((f) => f.id === picked.frameId)
    if (!frame) return false
    return setLayerLocked(frame, picked.selector, !isElementLocked(frame.html, picked.selector, true))
  }
  const selected = frames.filter((f) => s.selectedIds.includes(f.id))
  if (!selected.length) return false
  setFramesLocked(selected, !selected.every((f) => f.locked))
  return true
}

/** Remove one element; false when the selector no longer resolves (a
 *  collaborator rewrote the frame under the pick), in which case the stale
 *  pick is dropped so it cannot stand in for a frame selection. A locked
 *  element stays, and stays picked, so it can be unlocked. */
export function deleteLayer(frame: Frame, selector: string): boolean {
  if (isLayerLocked(frame, selector)) return false
  const html = removeElement(frame.html, selector)
  const store = useStore.getState()
  store.setSelectedElement(null)
  store.setElementPanelOpen(false)
  if (html === null) return false
  saveFrameHtml(frame, html)
  return true
}

/** ⌫ on the canvas: a picked element is always what goes, never the frame
 *  around it — a pick whose frame or selector no longer exists (deleted or
 *  rewritten by a collaborator) is dropped rather than falling through to
 *  the frames. Frames only go when nothing is picked, and locked frames
 *  never go from here. Returns false when the key had nothing to act on. */
export function deleteSelection(): boolean {
  const s = useStore.getState()
  const frames = s.canvas?.frames ?? []
  const picked = s.selectedElement
  if (picked) {
    const pickedFrame = frames.find((f) => f.id === picked.frameId)
    if (pickedFrame) deleteLayer(pickedFrame, picked.selector)
    else s.pickElement(null)
    return true
  }
  const selected = frames.filter((f) => s.selectedIds.includes(f.id) && !f.locked)
  if (!selected.length) return false
  deleteFramesTracked(selected)
  return true
}

export function duplicateLayer(frame: Frame, selector: string) {
  if (frame.locked || isLayerLocked(frame, selector)) return
  const html = duplicateElement(frame.html, selector)
  if (html !== null) saveFrameHtml(frame, html)
}

/* ---- the eye: hiding and showing, frames and elements alike ---- */

/** Hide the frames from the stage, or bring them back, as one undo step.
 *  A hidden frame keeps its row, its HTML and its exports — only the canvas
 *  stops drawing it. Frames already in the asked-for state are left alone. */
export function setFramesHidden(frames: Frame[], hidden: boolean) {
  const changed = frames.filter((f) => !!f.hidden !== hidden)
  if (!changed.length) return
  recordUpdates(changed.map((f) => ({ frameId: f.id, before: { hidden: !!f.hidden }, after: { hidden } })))
  const store = useStore.getState()
  for (const f of changed) {
    store.patchFrameLocal(f.id, { hidden })
    /* undo waits for the save, as it does for a drag — an immediate ⌘Z must
       not land before the hide it reverses. A save the server refused is
       rolled back, so the eye and the stage show what everyone else sees. */
    trackSave(
      api.updateFrame(f.id, { hidden }).catch((err: unknown) => {
        const s = useStore.getState()
        s.patchFrameLocal(f.id, { hidden: !hidden })
        s.pushNotice(errorMessage(err, `Couldn’t ${hidden ? 'hide' : 'show'} “${f.name}”`))
      }),
    )
  }
}

export function setFrameHidden(frame: Frame, hidden: boolean) {
  setFramesHidden([frame], hidden)
}

/** Hide one element inside the frame, or show it again; false when the
 *  selector no longer resolves. The mark lives in the frame's HTML, so it
 *  rides the same save as any other layer edit. */
export function setLayerHidden(frame: Frame, selector: string, hidden: boolean): boolean {
  const html = setElementHidden(frame.html, selector, hidden)
  if (html === null) return false
  if (html !== frame.html) saveFrameHtml(frame, html)
  // Text editing withholds HTML updates; its next save serializes the live iframe.
  void requestFrame(frame.id, 'doop:visibility', { selector, hidden })
  return true
}

/** ⌘⇧H: a picked element flips on its own; otherwise the selected frames
 *  move together — all shown when every one is hidden, hidden otherwise.
 *  False when the key had nothing to act on. */
export function toggleSelectionHidden(): boolean {
  const s = useStore.getState()
  const frames = s.canvas?.frames ?? []
  const picked = s.selectedElement
  if (picked) {
    const frame = frames.find((f) => f.id === picked.frameId)
    const hidden = frame ? isElementHidden(frame.html, picked.selector) : null
    if (frame && hidden !== null) setLayerHidden(frame, picked.selector, !hidden)
    return true
  }
  const selected = frames.filter((f) => s.selectedIds.includes(f.id))
  if (!selected.length) return false
  setFramesHidden(selected, !selected.every((f) => f.hidden))
  return true
}

/** Swap one element's markup; false when the selector no longer resolves or the element is locked. */
export function replaceLayerHtml(frame: Frame, selector: string, outerHtml: string): boolean {
  if (isLayerLocked(frame, selector)) return false
  const html = replaceElement(frame.html, selector, outerHtml)
  if (html === null) return false
  saveFrameHtml(frame, html)
  return true
}

/* a moved element keeps the selection: its selector changes with its
   position, so the rail and the frame outline have to be pointed at the new one */
function commitMove(frame: Frame, moved: MovedElement | null): boolean {
  if (!moved) return false
  saveFrameHtml(frame, moved.html)
  const store = useStore.getState()
  store.select(frame.id)
  store.setSelectedElement({ frameId: frame.id, selector: moved.selector })
  return true
}

/** Drop the element next to, or into, another; false when nothing moved. */
export function moveLayer(frame: Frame, selector: string, target: DropTarget, flow?: FlowPlacement): boolean {
  if (isLayerLocked(frame, selector)) return false
  return commitMove(frame, moveElement(frame.html, selector, target, flow))
}

/** Finish a drag that began on `pressed`: the element is moved in the frame
 *  as the store holds it now, unless its HTML changed during the gesture.
 *  A path selector can survive a collaborator's edit while pointing at a
 *  different element (a same-tag sibling inserted above shifts every
 *  nth-of-type below it), so a changed frame drops nothing. False when
 *  nothing moved. */
export function dropLayer(pressed: Frame, selector: string, target: DropTarget, flow?: FlowPlacement): boolean {
  const frame = useStore.getState().canvas?.frames.find((f) => f.id === pressed.id)
  if (!frame || frame.html !== pressed.html) return false
  return moveLayer(frame, selector, target, flow)
}

/** Step the element one layer up (-1) or down (1) among its siblings. */
export function shiftLayer(frame: Frame, selector: string, dir: -1 | 1): boolean {
  if (isLayerLocked(frame, selector)) return false
  return commitMove(frame, shiftElement(frame.html, selector, dir))
}
