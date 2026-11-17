import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ago, parseSession, sessionIn } from '../hooks/sessions'
import { appendTask, parseTasks, setStatus } from '../hooks/tasks'

const HOME = '/home/test'
const PATH = `${HOME}/work/tasks.md`
const OPTIONS = { options: { tasksFile: 'work/tasks.md', me: 'Alex', homeFolder: 'work' } }
const RECORDS = `${HOME}/Library/Application Support/Claude/claude-code-sessions`
const SPACE = `${RECORDS}/acct/space`
const NOW = Date.parse('2026-11-09T09:00:00')
const H = 3_600_000

const FILE = [
  '# Tasks',
  '',
  'One row per task.',
  '',
  '| id | added | due | who | task | source | status |',
  '|---|---|---|---|---|---|---|',
  '| 1 | 2026-11-07 | 2026-11-06 | Alex | Send the Monday note to Sam | chat | open |',
  '| 2 | 2026-11-07 | 2026-11-09 | Kim | Review the roadmap draft | memory | open |',
  '| 3 | 2026-11-07 | 2026-11-16 | Alex | Recheck the search ranking | memory | open |',
  '| 4 | 2026-11-07 | | Robin | Pricing for 3 customers | slack | open |',
  '| 5 | 2026-11-07 | | Alex | Write the launch post | chat local_bbbbbbbb-0000-0000-0000-000000000002 | open |',
  '| 6 | 2026-11-07 | | Alex | Old thing | chat | done |',
  '',
].join('\n')

const ME_CLI = 'cli-me'
const ME = 'local_aaaaaaaa-0000-0000-0000-000000000001'
const OTHER = 'local_bbbbbbbb-0000-0000-0000-000000000002'
const STUCK = 'local_cccccccc-0000-0000-0000-000000000003'

const record = (id: string, patch: Record<string, unknown>) =>
  JSON.stringify({ sessionId: id, cliSessionId: `cli-${id}`, cwd: '/home/test/work', isArchived: false, title: id, lastActivityAt: NOW - H, ...patch })

/** Session records: this session (2 h), a hot one with a wrap-up (30 min), one stuck on the user (3 d), an archived one, a scheduled run, an old one. */
const RECORDS_ON_DISK: Record<string, string> = {
  [`${SPACE}/${ME}.json`]: record(ME, { cliSessionId: ME_CLI, title: 'Chat organization', lastActivityAt: NOW - 2 * H }),
  [`${SPACE}/${OTHER}.json`]: record(OTHER, {
    title: 'Video review plan',
    cwd: '/home/test/dev/docs',
    lastActivityAt: NOW - H / 2,
    postTurnSummary: { status_category: 'completed', status_detail: 'Slack post answered', needs_action: '' },
  }),
  [`${SPACE}/${STUCK}.json`]: record(STUCK, {
    title: 'Budget tolerance',
    lastActivityAt: NOW - 3 * 24 * H,
    postTurnSummary: { status_category: 'blocked', status_detail: 'tolerance needs your call', needs_action: 'Is 5 % right for the budget?' },
  }),
  [`${SPACE}/local_dddddddd-0000-0000-0000-000000000004.json`]: record('local_dddddddd-0000-0000-0000-000000000004', { title: 'Archived one', isArchived: true }),
  [`${SPACE}/local_eeeeeeee-0000-0000-0000-000000000005.json`]: record('local_eeeeeeee-0000-0000-0000-000000000005', { title: 'Weekly prep', scheduledTaskId: 'task-1' }),
  [`${SPACE}/local_ffffffff-0000-0000-0000-000000000006.json`]: record('local_ffffffff-0000-0000-0000-000000000006', { title: 'Old one', lastActivityAt: NOW - 20 * 24 * H }),
  [`${SPACE}/scheduled-tasks.json`]: '{}',
}

const LOOPS = { command: 'open-loops', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const PANE = {
  plugin: 'open-loops',
  component: 'Pane',
  requestId: 'open-loops',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const END = { turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false } as const

type Where = { ran?: string[][]; path?: string; env?: Record<string, string>; records?: boolean }

/** A world with one tasks file (null: the file is not there) and, on a Mac, the session records; writes land back in `disk`. */
function world(on: On, disk: { text: string | null }, { ran = [], path = PATH, env = { HOME }, records = true }: Where = {}) {
  mock.clock(on, { now: NOW })
  mock.env(on, env)
  on('fs.exists', (_, e) => ({
    value: e.path === path ? disk.text !== null : records && (e.path === RECORDS || e.path === `${HOME}/Library/Application Support`),
  }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ME_CLI }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', (_, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    if (e.path === RECORDS) return { value: [dir('acct')] }
    if (e.path === `${RECORDS}/acct`) return { value: [dir('space')] }
    if (e.path === SPACE) {
      return {
        value: Object.keys(RECORDS_ON_DISK).map(p => {
          const text = RECORDS_ON_DISK[p]!
          const at = /lastActivityAt":(\d+)/.exec(text)?.[1]
          return { name: p.slice(SPACE.length + 1), kind: 'file' as const, size: text.length, mtimeMs: at ? +at : NOW, isLink: false }
        }),
      }
    }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.read', (_, e) => {
    if (e.path === path) {
      if (disk.text === null) throw new Error('ENOENT')
      return { value: disk.text }
    }
    const text = RECORDS_ON_DISK[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    expect(e.path).toBe(path)
    disk.text = e.text
    return { value: undefined }
  })
}

const start = async ($: Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]) => {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(LOOPS)
  // The session scan runs after the command answers; let it land.
  await $.turn.complete(END)
}

test('parseTasks reads the rows and nothing else; setStatus and appendTask touch one line', () => {
  const tasks = parseTasks(FILE)
  expect(tasks.map(t => t.id)).toEqual([1, 2, 3, 4, 5, 6])
  expect(tasks[3]).toEqual({ id: 4, added: '2026-11-07', due: null, who: 'Robin', text: 'Pricing for 3 customers', source: 'slack', status: 'open' })
  expect(tasks[5]!.status).toBe('done')

  const closed = setStatus(FILE, 4, 'done')
  expect(closed.split('\n').length).toBe(FILE.split('\n').length)
  expect(parseTasks(closed)[3]!.status).toBe('done')
  expect(closed).toContain('# Tasks')

  const { text, id } = appendTask(FILE, { added: '2026-11-09', due: null, who: 'Alex', text: 'A | new one', source: 'pane', status: 'open' })
  expect(id).toBe(7)
  expect(text).toContain('| 7 | 2026-11-09 |  | Alex | A / new one | pane | open |')
  expect(text.split('\n').at(-2)).toContain('| 7 |')
})

test('parseSession keeps what the board shows, drops scheduled runs and junk; ago and sessionIn', () => {
  const hot = parseSession(RECORDS_ON_DISK[`${SPACE}/${OTHER}.json`]!)!
  expect(hot.id).toBe(OTHER)
  expect(hot.folder).toBe('docs')
  expect(hot.status).toBe('done')
  expect(hot.detail).toBe('Slack post answered')
  const stuck = parseSession(RECORDS_ON_DISK[`${SPACE}/${STUCK}.json`]!)!
  expect(stuck.status).toBe('waiting')
  expect(stuck.detail).toBe('Is 5 % right for the budget?')
  expect(parseSession(RECORDS_ON_DISK[`${SPACE}/local_eeeeeeee-0000-0000-0000-000000000005.json`]!)).toBe(null)
  expect(parseSession('{}')).toBe(null)
  expect(parseSession('not json')).toBe(null)
  expect(parseSession(JSON.stringify({ sessionId: 'x', title: 'y', turnWrapUp: { needsUser: true, description: 'd' } }))!.status).toBe('waiting')

  expect(ago(NOW - 5 * 60_000, NOW)).toBe('5m')
  expect(ago(NOW - 3 * H, NOW)).toBe('3h')
  expect(ago(NOW - 49 * H, NOW)).toBe('2d')
  expect(sessionIn('chat local_bbbbbbbb-0000-0000-0000-000000000002')).toBe(OTHER)
  expect(sessionIn('slack')).toBe(null)
})

test('the board shows hot sessions, the open rows by due date, sessions waiting on you, and the closed rows', OPTIONS, async ($, on) => {
  world(on, { text: FILE })
  await start($)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = JSON.stringify(await ui.find({ type: 'Box' }))

    expect(all).toContain('5 open · 1 overdue · 1 on you')

    // Hot: the two sessions of the last 24 h, newest first, this one marked and without a button.
    const hotTitle = all.indexOf('Hot · last 24 h')
    const other = all.indexOf('Video review plan')
    const mine = all.indexOf('Chat organization (this one)')
    expect(hotTitle).toBeGreaterThan(-1)
    expect(other).toBeGreaterThan(hotTitle)
    expect(mine).toBeGreaterThan(other)
    expect(all).toContain('docs · 30m ago · Slack post answered')
    expect(all).toContain(`${OTHER}-open`)
    expect(all).not.toContain(`${ME}-open`)
    expect(all).not.toContain('Archived one')
    expect(all).not.toContain('Weekly prep')
    expect(all).not.toContain('Old one')

    // Open: due-dated rows first, then the stuck session, then waits and own work.
    expect(all).toContain('6 Nov · 3d overdue')
    expect(all).toContain('Overdue · 1')
    expect(all).toContain('9 Nov · today')
    expect(all).toContain('Coming up · 2')
    expect(all).toContain('16 Nov')
    const overdue = all.indexOf('Monday note to Sam')
    const today = all.indexOf('Review the roadmap draft')
    const later = all.indexOf('Recheck the search ranking')
    const stuck = all.indexOf('Sessions waiting on you · 1')
    const waiting = all.indexOf('Waiting on others · 1')
    const own = all.indexOf('To do · 1')
    expect(overdue).toBeGreaterThan(mine)
    expect(overdue).toBeLessThan(today)
    expect(today).toBeLessThan(later)
    expect(later).toBeLessThan(stuck)
    expect(stuck).toBeLessThan(waiting)
    expect(waiting).toBeLessThan(own)
    expect(all).toContain('● Budget tolerance')
    expect(all).toContain('3d ago · Is 5 % right for the budget?')
    expect(all).toContain('#4 · waits on Robin · slack')
    expect(all).toContain('t4-chase')
    expect(all).toContain('t5-start')
    expect(all).not.toContain('t5-chase')
    // A row from a session carries an open button and hides the id.
    expect(all).toContain('t5-open')
    expect(all).toContain('#5 · chat"')
    expect(all).not.toContain(`#5 · chat ${OTHER}`)

    // Done: the closed row, after everything open.
    const done = all.indexOf('done · Old thing')
    expect(done).toBeGreaterThan(own)
    await ui.unmount()
  }
})

test('open switches the app to the session with `open <link>` on a Mac', OPTIONS, async ($, on) => {
  const ran: string[][] = []
  world(on, { text: FILE }, { ran })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `${OTHER}-open` })
  expect(ran[0]).toEqual(['open', `claude://claude.ai/epitaxy/${OTHER}`])
  await ui.press({ key: 't5-open' })
  expect(ran[1]).toEqual(['open', `claude://claude.ai/epitaxy/${OTHER}`])
  await ui.unmount()
})

test('done and drop rewrite the file and the row moves to Done', OPTIONS, async ($, on) => {
  const disk = { text: FILE }
  world(on, disk)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 't1-done' })
  expect(parseTasks(disk.text)[0]!.status).toBe('done')
  let all = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(all).not.toContain('Overdue')
  expect(all).toContain('done · Send the Monday note to Sam')
  expect(all).toContain('4 open')

  await ui.press({ key: 't4-drop' })
  expect(parseTasks(disk.text)[3]!.status).toBe('dropped')
  all = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(all).not.toContain('Waiting on others')
  expect(all).toContain('dropped · Pricing for 3 customers')
  await ui.unmount()
})

test('the add field appends a row for the configured name, undated, source pane plus this session', OPTIONS, async ($, on) => {
  const disk = { text: FILE }
  world(on, disk)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'add', text: 'Call Sam about the budget' })
  expect(disk.text).toContain(`| 7 | 2026-11-09 |  | Alex | Call Sam about the budget | pane ${ME} | open |`)
  const all = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(all).toContain('To do · 2')
  expect(all).toContain('Call Sam about the budget')
  expect(all).toContain('#7 · pane"')
  expect(all).not.toContain('t7-open')

  await ui.input({ key: 'add', text: '   ' })
  expect(parseTasks(disk.text).length).toBe(7)
  await ui.unmount()
})

test('start and chase hand the row to Claude; the mark goes when the turn ends', OPTIONS, async ($, on) => {
  world(on, { text: FILE })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => (prompts.push(e.text), { text: e.text }))
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 't4-chase' })
  expect(prompts[0]).toMatch(/^Chase task 4: "Pricing for 3 customers", waiting on Robin \(tasks\.md row 4\)\. Draft a short follow-up to Robin .*don't send anything\.$/)
  await ui.press({ key: 't5-start' })
  expect(prompts[1]).toMatch(/^Start on task 5: "Write the launch post"/)
  expect(JSON.stringify(await ui.find({ type: 'Box' }))).toContain('sent to Claude')

  await $.turn.complete({ ...END, turnId: 't2' })
  expect(JSON.stringify(await ui.find({ type: 'Box' }))).not.toContain('sent to Claude')
  await ui.unmount()
})

test('/todo <text> asks Claude to add a row naming this session once the turn ends; bare /todo opens the pane', OPTIONS, async ($, on) => {
  world(on, { text: FILE })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => (prompts.push(e.text), { text: e.text }))
  await start($)
  expect(prompts.length).toBe(0)

  const ran = await $.command.run({ ...LOOPS, command: 'todo', args: 'ask Robin for the Q3 numbers by 20 Nov' })
  expect(ran.text).toBe('Asking Claude to add: "ask Robin for the Q3 numbers by 20 Nov".')
  expect(prompts.length).toBe(0)
  await $.turn.complete({ ...END, turnId: 't2' })
  expect(prompts[0]).toMatch(/^Add a task to ~\/work\/tasks\.md: "ask Robin for the Q3 numbers by 20 Nov"\./)
  expect(prompts[0]).toContain(`source "chat ${ME}"`)
  await $.turn.complete({ ...END, turnId: 't3' })
  expect(prompts.length).toBe(1)

  const bare = await $.command.run({ ...LOOPS, command: 'todo' })
  expect(bare.text).toBe('Board opened.')
  const board = await $.command.run({ ...LOOPS, command: 'board' })
  expect(board.text).toBe('Board opened: 5 open tasks.')
  await $.turn.complete({ ...END, turnId: 't4' })
  expect(prompts.length).toBe(1)
})

test('with no settings: the file is ~/tasks.md, missing until the first task creates it with its header', async ($, on) => {
  const path = `${HOME}/tasks.md`
  const disk: { text: string | null } = { text: null }
  world(on, disk, { path })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(all).toContain('No tasks file yet at ~/tasks.md')
  expect(all).not.toContain('Could not read')
  expect(all).toContain('Video review plan')
  // With no home folder set, every session names its folder.
  expect(all).toContain('work · 2h ago')

  await ui.input({ key: 'add', text: 'First thing' })
  expect(disk.text).toContain('| id | added | due | who | task | source | status |')
  expect(disk.text).toContain(`| 1 | 2026-11-09 |  | me | First thing | pane ${ME} | open |`)
  all = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(all).not.toContain('No tasks file yet')
  expect(all).toContain('To do · 1')
  await ui.unmount()
})

test('Done shows the newest closed rows up to the limit', { options: { tasksFile: 'work/tasks.md', me: 'Alex', doneLimit: 2 } }, async ($, on) => {
  const more = FILE + ['| 7 | 2026-11-08 | | Alex | Seventh | chat | dropped |', '| 8 | 2026-11-08 | | Alex | Eighth | chat | done |', ''].join('\n')
  world(on, { text: more })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(all).toContain('Done · latest 2 of 3')
  expect(all.indexOf('done · Eighth')).toBeLessThan(all.indexOf('dropped · Seventh'))
  expect(all).not.toContain('done · Old thing')
  await ui.unmount()
})

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as const

test('Claude is told where the tasks file is, unless the setting is off', OPTIONS, async ($, on) => {
  world(on, { text: FILE })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' as const }] }))
  await start($)
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(x => x.id)).toEqual(['base', 'open-loops:tasks'])
  expect(sections[1]!.text).toContain('~/work/tasks.md')
  expect(sections[1]!.text).toContain('who Alex')
})

test('teachClaude off leaves the system prompt alone', { options: { teachClaude: false } }, async ($, on) => {
  world(on, { text: null }, { path: `${HOME}/tasks.md` })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' as const }] }))
  await start($)
  expect((await $.prompt.compose(COMPOSE)).sections.map(x => x.id)).toEqual(['base'])
})

test('on Windows with no session records the Hot column says so, and open uses start', OPTIONS, async ($, on) => {
  const ran: string[][] = []
  world(on, { text: FILE }, { ran, env: { HOME, APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, records: false })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(all).toContain('this column needs the Claude desktop app')
  expect(all).not.toContain('Could not read the session records')
  expect(all).toContain('5 open')
  await ui.press({ key: 't5-open' })
  expect(ran[0]).toEqual(['cmd', '/c', 'start', '""', `claude://claude.ai/epitaxy/${OTHER}`])
  await ui.unmount()
})
