export type Status = 'open' | 'done' | 'dropped'

/** One row of the tasks file. `who` is the configured name for your own work, else the person waited on. */
export type Task = { id: number; added: string; due: string | null; who: string; text: string; source: string; status: Status }

/** One read of the tasks file: its rows, when, whether it is not there yet, or why it could not be read. */
export type Scan = { tasks: Task[]; scannedAt: number; missing?: boolean; error?: string }

/** How a session's last turn ended: waiting on you, done, or no wrap-up recorded. */
export type SessionStatus = 'waiting' | 'done' | 'none'

/** One Code session as the desktop app records it, reduced to what the board shows. */
export type SessionRow = {
  id: string
  cli: string
  title: string
  folder: string
  lastActivityAt: number
  isArchived: boolean
  status: SessionStatus
  detail: string
}

/** One read of the session records: the rows touched in the last week, when, whether this host has none, or why they could not be read. */
export type Board = { sessions: SessionRow[]; scannedAt: number; unavailable?: boolean; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'open-loops': {
      scan: Shaped<Scan | null>
      board: Shaped<Board | null>
      sent: Shaped<number[]>
      pending: Shaped<string | null>
      /** This session's own app id (local_…), once matched by CLI session id; null until then. */
      me: Shaped<string | null>
    }
  }
}
