import type { EngineInterface } from 'claude-code'

import type { SessionRow, SessionStatus } from '../types'

// The desktop app keeps one JSON per Code session under
// <app data>/Claude/claude-code-sessions/<account>/<workspace>/local_*.json:
// title, folder, last activity, archived flag and the last wrap-up's status.
// The board reads those records; nothing about a session is kept by hand.
// <app data> is ~/Library/Application Support on macOS (checked); %APPDATA% on
// Windows and ~/.config on Linux are the usual Electron places (not checked).

export type Host = 'mac' | 'windows' | 'linux'

/** Which host the board runs on, from the environment alone. */
export async function hostOf($: EngineInterface): Promise<Host> {
  if ((await $.env.get('OS')) === 'Windows_NT' || (await $.env.get('APPDATA'))) return 'windows'
  const home = (await $.env.get('HOME')) ?? ''
  return (await $.fs.exists(`${home}/Library/Application Support`).catch(() => false)) ? 'mac' : 'linux'
}

/** Where the desktop app's session records live on this host. */
export async function recordsDir($: EngineInterface, host: Host, home: string): Promise<string> {
  if (host === 'windows') return `${((await $.env.get('APPDATA')) ?? `${home}/AppData/Roaming`).replace(/\\/g, '/')}/Claude/claude-code-sessions`
  if (host === 'linux') return `${(await $.env.get('XDG_CONFIG_HOME')) ?? `${home}/.config`}/Claude/claude-code-sessions`
  return `${home}/Library/Application Support/Claude/claude-code-sessions`
}

/** The host command that opens a link with the desktop app. */
export const opener = (host: Host, link: string): string[] =>
  host === 'windows' ? ['cmd', '/c', 'start', '""', link] : host === 'linux' ? ['xdg-open', link] : ['open', link]
export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

/** The app link that opens a session, as list_sessions spells it. */
export const linkOf = (id: string): string => `claude://claude.ai/epitaxy/${id}`

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** One record, or null when it is not a session record or is a scheduled run (those show under their task). */
export function parseSession(text: string): SessionRow | null {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(text)
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || typeof d.sessionId !== 'string' || typeof d.title !== 'string') return null
  if (d.scheduledTaskId) return null
  const summary = (d.postTurnSummary ?? {}) as Record<string, unknown>
  const wrap = (d.turnWrapUp ?? {}) as Record<string, unknown>
  const category = str(summary.status_category)
  const waits = category === 'blocked' || category === 'review_ready' || wrap.needsUser === true
  const status: SessionStatus = waits ? 'waiting' : category === 'completed' ? 'done' : 'none'
  const cwd = str(d.cwd)
  return {
    id: d.sessionId,
    cli: str(d.cliSessionId),
    title: d.title,
    folder: cwd.split('/').filter(Boolean).pop() ?? '',
    lastActivityAt: typeof d.lastActivityAt === 'number' ? d.lastActivityAt : 0,
    isArchived: d.isArchived === true,
    status,
    detail: (str(summary.needs_action) || str(summary.status_detail) || str(wrap.description)).trim(),
  }
}

/** Every session record under `root` touched since `since` (ms), unarchived or not, newest first. */
export async function readSessions($: EngineInterface, root: string, since: number): Promise<SessionRow[]> {
  const rows: SessionRow[] = []
  for (const account of await $.fs.list(root)) {
    if (account.kind !== 'dir') continue
    for (const space of await $.fs.list(`${root}/${account.name}`)) {
      if (space.kind !== 'dir') continue
      const dir = `${root}/${account.name}/${space.name}`
      for (const f of await $.fs.list(dir)) {
        // A record not written since `since` cannot carry activity after it.
        if (f.kind !== 'file' || !f.name.startsWith('local_') || !f.name.endsWith('.json') || f.mtimeMs < since) continue
        let row: SessionRow | null
        try {
          row = parseSession(String(await $.fs.read(`${dir}/${f.name}`)))
        } catch {
          continue
        }
        if (row && row.lastActivityAt >= since) rows.push(row)
      }
    }
  }
  return rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}

/** "5m", "3h", "2d": how long ago, in the coarsest unit that is not zero. */
export const ago = (at: number, now: number): string => {
  const ms = Math.max(0, now - at)
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h`
  return `${Math.round(ms / DAY_MS)}d`
}

/** The session id a tasks.md `source` cell names, if any ("chat local_…"). */
export const sessionIn = (source: string): string | null => /local_[0-9a-f-]{36}/.exec(source)?.[0] ?? null
