import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { projectBindings } from './db/schema.ts'

/**
 * The project binding table (CHE-5860, CHE-5793 step 13): which canvas a Multica project designs
 * on. A binding is found by the project UUID and nothing else; the canvas name is never read.
 * A project has at most one binding, enforced by the primary key, so two racing binds cannot
 * both win. Canvases with no row stay legacy: readable and writable as before.
 */

export interface ProjectBinding {
  projectId: string
  canvasId: string
}

export async function getBinding(projectId: string): Promise<ProjectBinding | undefined> {
  const [row] = await db
    .select({ projectId: projectBindings.projectId, canvasId: projectBindings.canvasId })
    .from(projectBindings)
    .where(eq(projectBindings.projectId, projectId))
  return row
}

export function listBindings(): Promise<ProjectBinding[]> {
  return db.select({ projectId: projectBindings.projectId, canvasId: projectBindings.canvasId }).from(projectBindings)
}

/** Bind `projectId` to `canvasId` only if the project has no binding. Returns the winning
 *  binding, and `created` says whether this call made it. */
export async function bindProject(
  projectId: string,
  canvasId: string,
  userId: string,
): Promise<ProjectBinding & { created: boolean }> {
  const inserted = await db
    .insert(projectBindings)
    .values({ projectId, canvasId, boundBy: userId, boundAt: Date.now() })
    .onConflictDoNothing()
    .returning({ projectId: projectBindings.projectId })
  if (inserted.length) return { projectId, canvasId, created: true }
  const existing = await getBinding(projectId)
  /* the row cannot vanish: nothing deletes a binding */
  return { projectId, canvasId: existing?.canvasId ?? canvasId, created: false }
}
