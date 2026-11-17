import type { Task, Status } from '../types'

// tasks.md is a markdown table, one row per task. The parser keeps every other
// line as it is, so a status change or an appended row touches one line only.

const COLUMNS = ['id', 'added', 'due', 'who', 'task', 'source', 'status'] as const
const ISO = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim())

const isRow = (line: string): boolean => /^\s*\|\s*\d+\s*\|/.test(line)

const statusOf = (s: string): Status => (s === 'done' || s === 'dropped' ? s : 'open')

/** A new tasks file: a short header and the empty table. */
export const NEW_FILE = [
  '# Tasks',
  '',
  'One row per task, newest last. `who` is you for your own work, otherwise the person you wait on. `due` is YYYY-MM-DD or empty. `status` is open, done or dropped.',
  '',
  `| ${COLUMNS.join(' | ')} |`,
  `|${COLUMNS.map(() => '---').join('|')}|`,
  '',
].join('\n')

/** Every task row in the file, in file order; an empty `who` is `me`. */
export function parseTasks(text: string, me = 'me'): Task[] {
  const tasks: Task[] = []
  for (const line of text.split('\n')) {
    if (!isRow(line)) continue
    const c = cells(line)
    if (c.length < COLUMNS.length) continue
    const [id, added, due, who, task, source, status] = c
    tasks.push({
      id: +id!,
      added: added ?? '',
      due: due && ISO.test(due) ? due : null,
      who: who || me,
      text: task ?? '',
      source: source ?? '',
      status: statusOf(status ?? ''),
    })
  }
  return tasks
}

const rowOf = (t: Task): string =>
  `| ${t.id} | ${t.added} | ${t.due ?? ''} | ${t.who} | ${t.text.replace(/\|/g, '/')} | ${t.source} | ${t.status} |`

/** The file with one row's status changed; unchanged when the id is not there. */
export function setStatus(text: string, id: number, status: Status): string {
  return text
    .split('\n')
    .map(line => {
      if (!isRow(line)) return line
      const c = cells(line)
      if (+c[0]! !== id) return line
      const [, added, due, who, task, source] = c
      return rowOf({ id, added: added ?? '', due: due || null, who: who ?? '', text: task ?? '', source: source ?? '', status })
    })
    .join('\n')
}

/** The file with a new row after the last one (or after the table header when empty). */
export function appendTask(text: string, task: Omit<Task, 'id'>): { text: string; id: number } {
  const lines = text.split('\n')
  const tasks = parseTasks(text)
  const id = tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1
  const row = rowOf({ ...task, id })
  let at = -1
  for (const [i, line] of lines.entries()) {
    if (isRow(line) || /^\s*\|\s*-+\s*\|/.test(line)) at = i
  }
  if (at < 0) {
    const header = `| ${COLUMNS.join(' | ')} |\n|${COLUMNS.map(() => '---').join('|')}|`
    return { text: `${text.replace(/\s*$/, '')}\n\n${header}\n${row}\n`, id }
  }
  lines.splice(at + 1, 0, row)
  return { text: lines.join('\n'), id }
}

/** Today in the machine's local time, as YYYY-MM-DD. */
export const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Whole days from `date` to `today`; positive when the date is past. */
export const daysPast = (date: string, today: string): number =>
  Math.round((Date.parse(today) - Date.parse(date)) / DAY_MS)
