import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Board, Scan, SessionRow, Task } from '../types'
import { DAY_MS, HOUR_MS, ago, hostOf, linkOf, opener, readSessions, recordsDir, sessionIn } from './sessions'
import { NEW_FILE, appendTask, dayOf, daysPast, parseTasks, setStatus } from './tasks'

// A board beside the chat, three columns top to bottom:
//   Hot    sessions touched in the last 24 h, from the desktop app's own records,
//          with the last wrap-up's status; red when one stopped waiting on you.
//   Open   the open rows of the tasks file (dated ones by due date, overdue in
//          red, today in amber; then what waits on others; then your own undated
//          work) and the sessions of the last week that still wait on you.
//          done / drop rewrite the file; start and chase hand the row to Claude
//          in chat; open switches the app to a session.
//   Done   the latest closed rows.
// `/todo <text>` asks Claude to add a row; `/open-loops` and `/board` open the pane.
// The tasks file, your name and the rest come from the plugin's settings
// (userConfig in plugin.json).

const PANE = 'open-loops'
const TITLE = 'Board'
const HOT_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const TICK_MS = 5 * 60_000

const RED = '#f2665b'
const AMBER = '#e3a42f'
const GREEN = '#6cbf7a'
const DIM = '#8d929b'

const scan = atom({ plugin: 'open-loops', key: 'scan' } as const, null, { shape: 'scan-2' })
const board = atom({ plugin: 'open-loops', key: 'board' } as const, null as Board | null, { shape: 'board-1' })
// Ids handed to Claude this turn; cleared when the turn ends and the file is reread.
const sent = atom({ plugin: 'open-loops', key: 'sent' } as const, [] as number[], { shape: 'sent-2' })
// Text from `/todo <text>`, submitted to Claude when the command's turn ends: a
// prompt cannot be submitted from inside the command itself.
const pending = atom({ plugin: 'open-loops', key: 'pending' } as const, null as string | null, { shape: 'pending-1' })
// This session's own app id, so a row added from here can name it in `source`.
const me = atom({ plugin: 'open-loops', key: 'me' } as const, null as string | null, { shape: 'me-1' })

/** The settings, as `register(on, options)` receives them. */
export type Config = { tasksFile: string; me: string; homeFolder: string; doneLimit: number; teachClaude: boolean }

export const configOf = (o: Readonly<Record<string, unknown>> = {}): Config => ({
  tasksFile: (typeof o.tasksFile === 'string' && o.tasksFile.trim()) || 'tasks.md',
  me: (typeof o.me === 'string' && o.me.trim()) || 'me',
  homeFolder: typeof o.homeFolder === 'string' ? o.homeFolder.trim() : '',
  doneLimit: typeof o.doneLimit === 'number' && o.doneLimit >= 0 ? Math.floor(o.doneLimit) : 10,
  teachClaude: o.teachClaude !== false,
})

let cfg = configOf()

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
/** The tasks file as Claude is told it: `~/…` under home, else as configured. */
export const shownPath = (file: string): string => (isAbsolute(file) || file.startsWith('~/') ? file : `~/${file}`)

const home = async ($: EngineInterface): Promise<string> => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
const pathOf = async ($: EngineInterface): Promise<string> => {
  const f = cfg.tasksFile
  if (isAbsolute(f)) return f
  return `${await home($)}/${f.replace(/^~\//, '')}`
}
const fileName = (): string => cfg.tasksFile.split(/[\\/]/).pop() || 'tasks.md'

export function instruction(action: 'start' | 'chase' | 'add', t: Task | string, self?: string | null, c: Config = cfg): string {
  if (typeof t === 'string') {
    const source = self ? `"chat ${self}"` : '"chat"'
    return `Add a task to ${shownPath(c.tasksFile)}: "${t}". One row in the table (format in the file header; if the file does not exist, create it with the header row | id | added | due | who | task | source | status |): today as added, a due date and a who if the text gives them (else empty due, who ${c.me}), source ${source}, status open. Confirm in one line with the row's id.`
  }
  const where = `(${fileName()} row ${t.id})`
  if (action === 'start') {
    return `Start on task ${t.id}: "${t.text}" ${where}. Say in one line what you plan to do, then do it; when it is done ask me before marking the row done.`
  }
  return `Chase task ${t.id}: "${t.text}", waiting on ${t.who} ${where}. Draft a short follow-up to ${t.who} here in chat for me to send myself; don't send anything.`
}

/** Teaches Claude where the tasks live, when the setting allows. */
export const teaching = (c: Config): string =>
  `Tasks (open-loops board): the user's tasks live in ${shownPath(c.tasksFile)}, a markdown table (format in its header). When a message starts with "task:", add one row there: today as added, a due date and a who if the text gives them (else empty due, who ${c.me}), source "chat", status open, and confirm in one line with the row's id. When the user says a task is done or dropped, set that row's status.`

async function rescan($: EngineInterface): Promise<Task[]> {
  const now = await $.clock.now()
  const path = await pathOf($)
  let result: Scan
  try {
    if (!(await $.fs.exists(path))) result = { tasks: [], scannedAt: now, missing: true }
    else result = { tasks: parseTasks(String(await $.fs.read(path)), cfg.me), scannedAt: now }
  } catch (err) {
    result = { tasks: [], scannedAt: now, error: `Could not read ${path}: ${String(err)}` }
  }
  await update($, scan, () => result)
  return result.tasks
}

async function rescanSessions($: EngineInterface): Promise<SessionRow[]> {
  const now = await $.clock.now()
  let result: Board
  try {
    const root = await recordsDir($, await hostOf($), await home($))
    result = (await $.fs.exists(root))
      ? { sessions: await readSessions($, root, now - WEEK_MS), scannedAt: now }
      : { sessions: [], scannedAt: now, unavailable: true }
  } catch (err) {
    result = { sessions: [], scannedAt: now, error: `Could not read the session records: ${String(err)}` }
  }
  await update($, board, () => result)
  if ((await read($, me)) === null) {
    const cli = await $.session.id()
    const own = result.sessions.find(s => s.cli === cli)
    if (own) await update($, me, () => own.id)
  }
  return result.sessions
}

const refresh = async ($: EngineInterface): Promise<void> => {
  await rescan($)
  await rescanSessions($)
}

async function edit($: EngineInterface, fn: (text: string) => string): Promise<void> {
  const path = await pathOf($)
  // Only a file that is not there starts from the template; a read that fails otherwise throws.
  const text = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : NEW_FILE
  await $.fs.write(path, fn(text))
  await rescan($)
}

async function hand($: EngineInterface, action: 'start' | 'chase', t: Task): Promise<void> {
  await update($, sent, ids => [...(ids ?? []), t.id])
  await $.prompt.submit({ text: instruction(action, t), asUser: true })
}

/** Switch the app to a session: the host's open command on its link. */
const show = async ($: EngineInterface, id: string): Promise<void> => {
  try {
    await $.process.run(opener(await hostOf($), linkOf(id)), { timeoutMs: 5_000 })
  } catch (err) {
    await $.ui.toast(`Could not open the session: ${String(err)}`)
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "30 Oct", with the year when it is not this year's. */
const label = (date: string, today: string): string =>
  `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]}${date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${date.slice(0, 4)}`}`

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function openPane($: EngineInterface): Promise<{ text: string }> {
  const tasks = await rescan($)
  void rescanSessions($)
  await $.ui.open({ id: PANE, title: TITLE })
  return { text: `Board opened: ${tasks.filter(t => t.status === 'open').length} open tasks.` }
}

export const register: Register = (on, options) => {
  cfg = configOf(options)

  // Hooked only when on: a hook that is there but answers nothing still gets
  // a "skipped" notice in organizations whose security module runs first.
  if (cfg.teachClaude) {
    on('prompt.compose', async ($, e, next) => {
      const result = await next(e)
      return { sections: [...result.sections, { id: 'open-loops:tasks', text: teaching(cfg), scope: 'session' as const }] }
    }).catch(($, e, next) => next(e))
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'open-loops', description: 'Show the board (hot sessions, open tasks, done) in a pane' })
    await $.command.register({ name: 'board', description: 'Show the board (hot sessions, open tasks, done) in a pane' })
    await $.command.register({ name: 'todo', description: 'Add a task: /todo <text, with a due date and who if any>; alone, opens the pane' })
    void refresh($)
    $.clock.every(TICK_MS, () => void rescanSessions($))
    return next(e)
  })

  // Claude may have appended or closed rows during the turn, and other
  // sessions moved on: reread both, free the handed rows, submit a queued /todo.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await update($, sent, () => [])
      await refresh($)
      const queued = await read($, pending)
      if (queued) {
        await update($, pending, () => null)
        await $.prompt.submit({ text: instruction('add', queued, await read($, me)), asUser: true })
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'open-loops' }, $ => openPane($)).catch(() => ({ text: 'Board: the pane could not be opened.' }))
  on('command.run', { command: 'board' }, $ => openPane($)).catch(() => ({ text: 'Board: the pane could not be opened.' }))

  on('command.run', { command: 'todo' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) {
      await openPane($)
      return { text: 'Board opened.' }
    }
    await update($, pending, () => text)
    return { text: `Asking Claude to add: "${text}".` }
  }).catch(() => ({ text: 'Board: could not hand the task to Claude.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const s = await read($, scan)
    const b = await read($, board)
    const self = await read($, me)
    const handed = new Set(await read($, sent))
    const now = await $.clock.now()
    const today = dayOf(now)
    const open = s?.tasks.filter(t => t.status === 'open') ?? []
    const overdue = open.filter(t => t.due && daysPast(t.due, today) > 0)

    const live = (b?.sessions ?? []).filter(x => !x.isArchived)
    const hot = live.filter(x => now - x.lastActivityAt < HOT_MS)
    const stuck = live.filter(x => now - x.lastActivityAt >= HOT_MS && x.status === 'waiting')
    const waitsInHot = hot.filter(x => x.status === 'waiting').length

    const header = (
      <Box flexDirection="row" justifyContent="space-between" gap="sm">
        <Text bold>{s ? `${open.length} open${overdue.length ? ` · ${overdue.length} overdue` : ''}${waitsInHot + stuck.length ? ` · ${waitsInHot + stuck.length} on you` : ''}` : 'Not read yet'}</Text>
        {s ? <Text dimColor>{clock(s.scannedAt)}</Text> : null}
        <Button key="refresh" label="refresh" hotkey="r" onPress={() => void refresh($)} />
      </Box>
    )
    if (!s) return <Box flexDirection="column">{header}</Box>

    const add = (
      <Input
        key="add"
        placeholder={`new task, Enter to add (who = ${cfg.me}, no due)`}
        submitLabel="add"
        onSubmit={value => {
          const text = value.trim()
          if (!text) return
          const source = self ? `pane ${self}` : 'pane'
          void edit($, file => appendTask(file, { added: today, due: null, who: cfg.me, text, source, status: 'open' }).text)
        }}
      />
    )

    const dated = open.filter(t => t.due).sort((a, b) => a.due!.localeCompare(b.due!))
    const coming = dated.filter(t => daysPast(t.due!, today) <= 0)
    const waiting = open.filter(t => !t.due && t.who !== cfg.me)
    const own = open.filter(t => !t.due && t.who === cfg.me)
    const closedAll = s.tasks.filter(t => t.status !== 'open').sort((a, b) => b.id - a.id)
    const closed = closedAll.slice(0, cfg.doneLimit)

    const session = (x: SessionRow) => {
      const waits = x.status === 'waiting'
      const where = x.folder && x.folder !== cfg.homeFolder ? `${x.folder} · ` : ''
      const mine = x.id === self
      return (
        <Box key={x.id} flexDirection="column">
          <Box flexDirection="row" gap="sm">
            <Text bold color={waits ? RED : undefined}>{`${waits ? '● ' : ''}${x.title}${mine ? ' (this one)' : ''}`}</Text>
            {mine ? null : <Button key={`${x.id}-open`} label="open" onPress={() => void show($, x.id)} />}
          </Box>
          <Text dimColor>{`${where}${ago(x.lastActivityAt, now)} ago${x.detail ? ` · ${x.detail}` : ''}`}</Text>
        </Box>
      )
    }

    const task = (t: Task, done = false) => {
      const past = t.due ? daysPast(t.due, today) : 0
      const day = t.due ? label(t.due, today) : ''
      const when = past > 0 ? `${day} · ${past}d overdue` : t.due && past === 0 ? `${day} · today` : day
      const tone = done ? {} : past > 0 ? { color: RED, bold: true } : t.due && past === 0 ? { color: AMBER, bold: true } : {}
      const id = `t${t.id}`
      const mine = t.who === cfg.me
      const from = sessionIn(t.source)
      const source = from ? t.source.replace(from, '').trim() || 'chat' : t.source
      if (done) {
        return (
          <Box key={id} flexDirection="column">
            <Text dimColor>{`${t.status === 'dropped' ? 'dropped' : 'done'} · ${t.text}`}</Text>
          </Box>
        )
      }
      return (
        <Box key={id} flexDirection="column">
          {when ? <Text {...tone}>{when}</Text> : null}
          <Text>{t.text}</Text>
          <Text dimColor>{`#${t.id} · ${mine ? source : `waits on ${t.who} · ${source}`}`}</Text>
          {handed.has(t.id) ? (
            <Text dimColor italic>sent to Claude…</Text>
          ) : (
            <Box flexDirection="row" gap="sm">
              <Button key={`${id}-done`} label="done" onPress={() => void edit($, f => setStatus(f, t.id, 'done'))} />
              {mine ? (
                <Button key={`${id}-start`} label="start" onPress={() => void hand($, 'start', t)} />
              ) : (
                <Button key={`${id}-chase`} label="chase" onPress={() => void hand($, 'chase', t)} />
              )}
              {from && from !== self ? <Button key={`${id}-open`} label="open" onPress={() => void show($, from)} /> : null}
              <Button key={`${id}-drop`} label="drop" onPress={() => void edit($, f => setStatus(f, t.id, 'dropped'))} />
            </Box>
          )}
        </Box>
      )
    }

    const group = (key: string, title: string, rows: RenderChildren[], color = DIM) =>
      rows.length === 0 ? null : (
        <Box key={key} flexDirection="column" gap="xs">
          <Text bold color={color}>{`${title} · ${rows.length}`}</Text>
          {rows}
        </Box>
      )

    const column = (key: string, title: string, color: string, body: RenderChildren[]) => (
      <Box key={key} flexDirection="column" gap="xs" borderStyle="round" borderColor={color} paddingX={1}>
        <Text bold color={color}>{title}</Text>
        {body}
      </Box>
    )

    const hotBody = b?.error
      ? [<Text key="err" color={RED}>{b.error}</Text>]
      : b?.unavailable
        ? [<Text key="none" dimColor>No session records found: this column needs the Claude desktop app.</Text>]
        : hot.length === 0
        ? [<Text key="none" dimColor>Nothing touched in the last 24 h.</Text>]
        : hot.map(session)

    const openBody = [
      s.error ? <Text key="err" color={RED}>{s.error}</Text> : null,
      s.missing ? <Text key="missing" dimColor>{`No tasks file yet at ${shownPath(cfg.tasksFile)}; the first task you add creates it.`}</Text> : null,
      add,
      open.length === 0 && stuck.length === 0 ? <Text key="none" dimColor>No open tasks.</Text> : null,
      group('overdue', 'Overdue', overdue.map(t => task(t)), RED),
      group('coming', 'Coming up', coming.map(t => task(t))),
      group('stuck', 'Sessions waiting on you', stuck.map(session), RED),
      group('waiting', 'Waiting on others', waiting.map(t => task(t))),
      group('own', 'To do', own.map(t => task(t))),
    ]

    const doneBody = closed.length === 0 ? [<Text key="none" dimColor>Nothing closed yet.</Text>] : closed.map(t => task(t, true))
    const doneTitle = closedAll.length > closed.length ? `Done · latest ${closed.length} of ${closedAll.length}` : 'Done'

    return (
      <Box flexDirection="column" gap="sm">
        {header}
        {column('hot', 'Hot · last 24 h', AMBER, hotBody)}
        {column('open', 'Open', DIM, openBody)}
        {column('done', doneTitle, GREEN, doneBody)}
      </Box>
    )
  })
}
