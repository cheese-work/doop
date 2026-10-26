import Anthropic from '@anthropic-ai/sdk'
import type { ModelAccount } from './modelAccounts.ts'
import { ACCOUNT_KIND_LABELS, type ModelOption } from '../shared/modelMenu.ts'

/**
 * The models a connected account can run right now, asked of the provider
 * with the user's own credential. The curated menu in `shared/` stays the
 * list of recommendations (order, blurb, default); the provider's catalog
 * says which of them this account actually has and which newer ones it has
 * gained since the menu was written, so a release no longer waits on a
 * hand edit here.
 *
 * Nothing is cached: the picker asks when it opens and Settings when it
 * loads, one catalog call each, well under a second on every provider.
 * When the call fails the curated menu is served with `live: false` and a
 * message, never an empty picker.
 */

export interface ModelCatalog {
  models: ModelOption[]
  /** true when `models` came from the provider; false means the curated fallback */
  live: boolean
  /** why the provider's list could not be loaded, for the picker's caption */
  error?: string
}

/* the output budget resident.ts asks for per turn; a model capped lower would 400 */
const TURN_OUTPUT_TOKENS = 16_000

/** An id shaped like an Anthropic model the Messages API will accept. The
 *  catalog decides what is offered; the run decides what works. */
export const CLAUDE_API_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,98}$/

/** Messages models with image input and room for a full turn, newest first.
 *  The SDK pages through `/v1/models` itself and honours ANTHROPIC_BASE_URL. */
async function anthropicModels(apiKey: string, signal: AbortSignal): Promise<ModelOption[]> {
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  const models: (ModelOption & { createdAt: string })[] = []
  for await (const model of client.models.list({ limit: 1000 }, { signal })) {
    if (!CLAUDE_API_MODEL.test(model.id)) continue
    if (model.capabilities && !model.capabilities.image_input.supported) continue
    if (model.max_tokens != null && model.max_tokens < TURN_OUTPUT_TOKENS) continue
    models.push({ id: model.id, name: model.display_name, blurb: '', vision: true, createdAt: model.created_at })
  }
  return models
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .map(({ createdAt: _createdAt, ...model }) => model)
}

type Loader = (account: ModelAccount, signal: AbortSignal) => Promise<ModelOption[]>

const LOADERS: Partial<Record<ModelAccount['kind'], Loader>> = {
  'anthropic-key': (account, signal) => anthropicModels(account.apiKey ?? '', signal),
}

/** Curated entries the provider confirms come first, in curated order, with
 *  their blurbs; the rest of the catalog follows. A curated id the provider
 *  does not list is dropped — offering a tier the account cannot run is the
 *  bug this exists to fix. */
function merge(curated: ModelOption[], live: ModelOption[]): ModelOption[] {
  const liveById = new Map(live.map((model) => [model.id, model]))
  const recommended = curated.flatMap((option) => {
    const found = liveById.get(option.id)
    if (!found) return []
    liveById.delete(option.id)
    return [{ ...found, ...option, recommended: true }]
  })
  return [...recommended, ...liveById.values()]
}

/** The menu for this account: the provider's list merged over the curated
 *  one, or the curated one alone for a kind with no catalog yet, or when the
 *  provider cannot be reached. */
export async function modelCatalogFor(account: ModelAccount, curated: ModelOption[]): Promise<ModelCatalog> {
  const load = LOADERS[account.kind]
  if (!load) return { models: curated, live: false }
  try {
    return { models: merge(curated, await load(account, AbortSignal.timeout(8_000))), live: true }
  } catch (error) {
    const label = ACCOUNT_KIND_LABELS[account.kind]
    const rejected = error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403)
    return {
      models: curated,
      live: false,
      error: rejected
        ? `${label} rejected the connected key. Reconnect it to see its models.`
        : `Could not load models from ${label}. Showing the built-in list.`,
    }
  }
}
