// RED STUB (CHE-9957): the naive design. The report job waits for the c00 job's conclusion, however long it takes.
export async function waitForC00({ observe, now, sleep }) {
  const start = now()
  for (;;) {
    const job = await observe()
    if (job && job.conclusion) return { ok: job.conclusion === 'success', message: `c00 ${job.conclusion}` }
    if (now() - start >= 60 * 60_000) return { ok: false, message: 'c00 never finished' }
    await sleep(15_000)
  }
}
