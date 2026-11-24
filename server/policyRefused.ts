/** A refused write. A separate type: the store's `undefined` means "not found". */
export class PolicyRefused extends Error {
  constructor(
    readonly op: string,
    readonly reason: string,
    /** `policy_refused` unless a subclass names its own refusal (`page_finished`) */
    readonly code: string = 'policy_refused',
  ) {
    super(`${code}: ${op}: ${reason}`)
  }
}
