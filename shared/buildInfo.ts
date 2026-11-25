/* The build label people read in Settings: `<version>-<build> · <commit>` (CHE-9772, parent CHE-9323), the format
   of the multica fork (CHE-1307, CHE-1910). `build` is the COMMIT time as YYYYMMDD-hhmm in ICT (Asia/Ho_Chi_Minh,
   UTC+7, no DST). `commit` is the first 8 characters of the SHA. Whatever was not stamped reads `dev`. */
export interface BuildInfo {
  version: string
  build: string
  commit: string
  label: string
}

export interface BuildStamp {
  version: string
  /** full commit SHA, from the DOOP_REVISION build arg */
  revision?: string
  /** commit time, ISO 8601 (`git show -s --format=%cI`), from the DOOP_COMMIT_TIME build arg */
  commitTime?: string
}

const DEV = 'dev'

const ict = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function buildStamp(commitTime: string | undefined): string {
  const at = commitTime ? new Date(commitTime) : null
  if (!at || Number.isNaN(at.getTime())) return DEV
  const p = Object.fromEntries(ict.formatToParts(at).map((part) => [part.type, part.value]))
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`
}

export function buildInfo({ version, revision, commitTime }: BuildStamp): BuildInfo {
  const build = buildStamp(commitTime)
  const sha = revision?.trim().toLowerCase() ?? ''
  const commit = /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 8) : DEV
  return { version, build, commit, label: `${version}-${build}${commit === DEV ? '' : ` · ${commit}`}` }
}
