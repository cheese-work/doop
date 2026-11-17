/* Names the browser-test hook step that stalls, so a CI timeout says which one
   (CHE-6913). 20s default, under the 60s hook timeout. */
export async function step<T>(label: string, run: () => Promise<T>, ms = 20_000): Promise<T> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`beforeEach step "${label}" stalled > ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
    console.log(`beforeEach step "${label}" took ${Date.now() - started} ms`)
  }
}

/* Chrome aborts in-flight requests with net::ERR_NETWORK_CHANGED when the host's
   network interfaces change (Docker files in the same run create and drop
   bridges). An aborted module import leaves the page loaded but its harness
   never set, and a wait cannot recover; loading the page again does (CHE-7020). */
export async function loadWithRetry(o: {
  attempts?: number
  load: () => Promise<unknown>
  ready: () => Promise<unknown>
  /** read before each retry and on the final failure */
  diagnose?: () => unknown
}): Promise<void> {
  const attempts = o.attempts ?? 3
  for (let n = 1; ; n++) {
    await o.load()
    try {
      await o.ready()
      return
    } catch (err) {
      const note = o.diagnose ? await Promise.resolve(o.diagnose()).catch((e) => `diagnosis failed: ${String(e)}`) : ''
      if (n >= attempts) {
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${note}`, { cause: err })
      }
      console.log(`page not ready on load ${n} of ${attempts}, loading again\n${note}`)
    }
  }
}
