import { Router, type Request, type RequestHandler, type Response } from 'express'
import * as chatBridge from './bridge.ts'
import { MAX_BRIDGE_TEXT } from '../shared/bridge.ts'
import type { CanvasRole } from '../shared/canvasRole.ts'
import type { Canvas } from '../shared/types.ts'

/** Resolves the canvas the caller may use, or answers the 404/403 itself and returns null. */
type RequireCanvas = (req: Request, res: Response, canvasId: string, need: CanvasRole) => Canvas | null

/* chat bridge: which Multica agent a canvas chats with, plus the list and
   liveness the watcher publishes. Same access gate as comments. */
type CanvasRequest = Request<{ id: string }>

/** Express 4 does not forward a rejected async handler, so a database error
 *  would leave the request hanging: answer it with a 500 instead. */
function guarded(handler: (req: CanvasRequest, res: Response) => Promise<unknown>): RequestHandler<{ id: string }> {
  return (req, res) => {
    handler(req, res).catch((err) => {
      console.error('[bridge] request failed:', err)
      if (!res.headersSent) res.status(500).json({ error: 'bridge unavailable' })
    })
  }
}

export function bridgeRouter(requireCanvas: RequireCanvas): Router {
  const router = Router()

  router.get(
    '/api/canvases/:id/bridge',
    guarded(async (req, res) => {
      const canvas = requireCanvas(req, res, req.params.id, 'view')
      if (!canvas) return
      res.json(await chatBridge.getBridge(canvas.id))
    }),
  )

  router.put(
    '/api/canvases/:id/bridge',
    guarded(async (req, res) => {
      const canvas = requireCanvas(req, res, req.params.id, 'comment')
      if (!canvas) return
      const { agentRef } = req.body ?? {}
      if (
        agentRef !== null &&
        (typeof agentRef !== 'string' || !agentRef.trim() || agentRef.length > MAX_BRIDGE_TEXT)
      ) {
        return res.status(400).json({ error: 'agentRef must be a non-empty string or null' })
      }
      await chatBridge.selectBridgeAgent(canvas.id, agentRef, req.user!.id)
      res.json(await chatBridge.getBridge(canvas.id))
    }),
  )

  return router
}
