import { roleAllows, type CanvasRole } from '../../shared/canvasRole'

/** A phone opened on a view or comment link is for looking, not editing: no
 *  editor panels, and the tool rail only when it carries the Comment tool.
 *  Desktop and phone editors keep their full layout. */
export function reviewLayout({ isMobile, role }: { isMobile: boolean; role: CanvasRole }) {
  const review = isMobile && !roleAllows(role, 'edit')
  return { review, toolRail: !review || roleAllows(role, 'comment'), panels: !review }
}
