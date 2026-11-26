import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, ProcessSpawnChunk } from 'claude-code'

import { toSpeech, windowAround } from './register'

const MENU = {
  plugin: 'paragraph-speaker',
  surface: 'desktop',
  component: 'ContextMenu',
} as const

const BAND = {
  plugin: 'paragraph-speaker',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

/** A typed /speak run: the engine stamps origin and presentation, so a stand-in will do. */
const speak = (args: string) =>
  ({ command: 'speak', args, origin: { kind: 'composer' }, presentation: {} }) as unknown as CommandRunInput

const RAN = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

type Spawned = AsyncGenerator<ProcessSpawnChunk, { value: { code: number; signal: null } }>

/** Lets the reading started in the background get as far as it can. */
async function settle(isDone: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 1000 && !isDone(); i++) await Promise.resolve()
}

/** A gate a stand-in process waits at until the test opens it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {}
  const wait = new Promise<void>(resolve => {
    open = resolve
  })
  return { wait, open }
}

test('markdown becomes single-spaced plain words', () => {
  expect(toSpeech('First **bold**  [link](https://x.y)\n\n- item `code`')).toBe('First bold link. item code.')
})

test('every line ends in punctuation, so the voice pauses between lines', () => {
  expect(toSpeech('## Setup\n- install it\n- run it then,\n- done!\nAsk me (later)')).toBe(
    'Setup. install it. run it then, done! Ask me (later).',
  )
})

test('a selected table is explained by a fast model, the text around it read as is', { timeoutMs: 30_000 }, async ($, on) => {
  const done = gate()
  const reply = [
    'Here are the two plans.',
    '',
    '| Plan | Price | Speed |',
    '|---|---|---|',
    '| Basic | 5 | slow |',
    '| Pro | 12 | fast |',
    '',
    'Pick the one that suits you.',
  ].join('\n')
  const spawned: string[] = []
  const asked: { model: string; prompt: string }[] = []
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', (_, e) => {
    asked.push({ model: e.model, prompt: e.prompt })
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: 'The table compares **two** plans: Pro costs more but is fast.', usage } }
  })
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push(e.input ?? '')
    yield { stream: 'stdout', text: 'pid 42\n' }
    await done.wait
    return { value: { code: 0, signal: null } }
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })

  // The reply has been drawn, so its markdown is known to the mod.
  const row = await $.ui.mount({
    plugin: 'paragraph-speaker',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'row-1',
    props: { text: reply, isFirstOfReply: true },
  })
  await row.unmount()

  // The copy of a drawn table: its cells, tab apart, as the desktop copies them.
  const copied = 'Here are the two plans.\nPlan\tPrice\tSpeed\nBasic\t5\tslow\nPro\t12\tfast\nPick the one that suits you.'
  const menu = await $.ui.mount({
    ...MENU,
    props: { selection: { text: copied }, row: { component: 'AssistantMessage', requestId: 'row-1' } },
  })
  await menu.press({ key: 'read-selection' })
  await settle(() => spawned.length > 0)

  expect(asked.length).toBe(1)
  expect(asked[0]!.model).toBe('haiku')
  expect(asked[0]!.prompt).toContain('Row 2: col 1: Pro | col 2: 12 | col 3: fast')
  expect(spawned).toEqual([
    'Here are the two plans. The table compares two plans: Pro costs more but is fast. Pick the one that suits you.',
  ])
  done.open()
  await settle()
  await menu.unmount()
})

const PLANS_REPLY = [
  'Here are the two plans.',
  '',
  '| Plan | Price | Speed |',
  '|---|---|---|',
  '| Basic | 5 | slow |',
  '| Pro | 12 | fast |',
  '',
  'Pick the one that suits you.',
].join('\n')
const PLANS_COPIED = 'Here are the two plans.\nPlan\tPrice\tSpeed\nBasic\t5\tslow\nPro\t12\tfast\nPick the one that suits you.'

/**
 * Stand-ins for a table read with the model's parts; the voice is at word 10,
 * inside the second part ("Pro costs twelve.", words 9 to 11), and waits there.
 */
function planReading(on: On, style: string | undefined, done: { wait: Promise<void> }): void {
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', (_, e) => ({ value: e.key === 'markStyle' ? style : undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', () => {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const text = JSON.stringify({
      parts: [
        { say: 'Two plans are compared.', refs: [] },
        { say: 'Pro costs twelve.', refs: [{ row: 2, col: 2 }] },
      ],
    })
    return { value: { isAnswered: true as const, text, usage } }
  })
  on('process.spawn', async function* (): Spawned {
    yield { stream: 'stdout', text: 'pid 42\nword 10\n' }
    await done.wait
    return { value: { code: 0, signal: null } }
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
}

async function readPlans($: Engine) {
  const row = () =>
    $.ui.mount({
      plugin: 'paragraph-speaker',
      surface: 'desktop',
      component: 'AssistantMessage',
      requestId: 'row-1',
      props: { text: PLANS_REPLY, isFirstOfReply: true },
    })
  const seen = await row() // the reply drawn: its markdown is known
  await seen.unmount()
  const menu = await $.ui.mount({
    ...MENU,
    props: { selection: { text: PLANS_COPIED }, row: { component: 'AssistantMessage', requestId: 'row-1' } },
  })
  await menu.press({ key: 'read-selection' })
  await settle()
  return { menu, drawn: await row() }
}

test('while a part of the explanation is spoken, its cells are orange in a table drawn the app’s size', { timeoutMs: 30_000 }, async ($, on) => {
  const done = gate()
  planReading(on, undefined, done) // orange, the default
  const { menu, drawn } = await readPlans($)
  const texts = await drawn.findAll({ type: 'Text' })
  // The table is the mod's, in the app's table's place: no markdown table left.
  expect((await drawn.findAll({ type: 'Markdown' })).some(m => String(m.props.text).includes('|'))).toBe(false)
  const marked = texts.filter(t => t.props.color === 'claude')
  expect(marked.map(t => [t.text, t.props.bold])).toEqual([['12', true]])
  // As the app draws its table: full width, a shaded box with 8px of padding to a cell, the header deeper.
  const boxes = await drawn.findAll({ type: 'Box' })
  const cells = boxes.filter(b => b.props.backgroundColor !== undefined)
  expect(cells.length).toBe(9)
  expect(cells.every(b => b.props.padding === 'sm')).toBe(true)
  expect(new Set(cells.slice(0, 3).map(b => b.props.backgroundColor)).size).toBe(1)
  expect(cells[0]!.props.backgroundColor).not.toBe(cells[3]!.props.backgroundColor)
  expect(boxes.some(b => b.props.width === '100%')).toBe(true)
  // Each column keeps one width down the table.
  expect(cells.map(b => b.props.width)).toEqual([0, 1, 2].flatMap(() => cells.slice(0, 3).map(b => b.props.width)))
  await drawn.unmount()
  done.open()
  await settle()
  await menu.unmount()
})

test('with /speak mark code, the cells it is about are inverted in the same table', { timeoutMs: 30_000 }, async ($, on) => {
  const done = gate()
  planReading(on, 'code', done)
  const { menu, drawn } = await readPlans($)
  const boxed = (await drawn.findAll({ type: 'Text' })).filter(t => t.props.inverse === true)
  expect(boxed.map(t => t.text)).toEqual(['12'])
  // The text around the table stays the app's own markdown.
  expect((await drawn.findAll({ type: 'Markdown' })).map(m => m.props.text)).toEqual([
    'Here are the two plans.',
    'Pick the one that suits you.',
  ])
  await drawn.unmount()
  done.open()
  await settle()
  await menu.unmount()
})

test('the row shows the spoken word, a third of the way in, within the width', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen'.split(' ')
  const { start, end } = windowAround(words, 8, 30)
  const shown = words.slice(start, end + 1).join(' ')
  expect(start).toBeGreaterThan(0)
  expect(start).toBeLessThanOrEqual(8)
  expect(end).toBeGreaterThanOrEqual(8)
  expect(shown.length).toBeLessThanOrEqual(30)
  expect(windowAround(['short', 'text'], -1, 80)).toEqual({ start: 0, end: 1 })
})

test('right-click Read aloud speaks the selection with Kokoro, in the chosen voice', async ($, on) => {
  const spawned: { argv: readonly string[]; input?: string }[] = []
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', (_, e) => ({ value: !e.path.includes('Packages') }))
  on('store.get', () => ({ value: 'bm_george' }))
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push({ argv: e.argv, input: e.input })
    yield { stream: 'stdout', text: 'pid 42\n' }
    return { value: { code: 0, signal: null } }
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'Only **this** part.' } } })
  await ui.press({ key: 'read-selection' })
  await settle(() => spawned.length > 0)
  await ui.unmount()

  expect(spawned.length).toBe(1)
  expect(spawned[0]!.input).toBe('Only this part.')
  expect(spawned[0]!.argv).toEqual([
    'C:\\L\\paragraph-speaker\\venv\\Scripts\\python.exe',
    '-I',
    'C:\\mod\\tts\\kokoro_speak.py',
    '--model',
    'C:\\L\\paragraph-speaker\\models\\kokoro-v1.0.onnx',
    '--voices',
    'C:\\L\\paragraph-speaker\\models\\voices-v1.0.bin',
    '--voice',
    'bm_george',
  ])
})

test('the spoken word is marked in the reply row itself, and only there', async ($, on) => {
  const done = gate()
  const reply = 'Intro.\n\nOnly **this** part is read aloud.'
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', (_, e) => ({ value: e.key === 'markStyle' ? 'code' : undefined }))
  on('process.spawn', async function* (): Spawned {
    yield { stream: 'stdout', text: 'pid 42\nsentence 0 2\nword 0\nword 1\n' }
    await done.wait
    return { value: { code: 0, signal: null } }
  })
  // The engine's own drawing of a reply row, standing in: it draws the text it is handed.
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  const row = (requestId: string) =>
    $.ui.mount({
      plugin: 'paragraph-speaker',
      surface: 'desktop',
      component: 'AssistantMessage',
      requestId,
      props: { text: reply, isFirstOfReply: true },
    })

  const menu = await $.ui.mount({
    ...MENU,
    props: { selection: { text: 'Only this part is read', requestId: 'row-1' } },
  })
  await menu.press({ key: 'read-selection' })
  await settle()

  const read = await row('row-1')
  expect((await read.find({ type: 'Text' }))?.text).toBe('Intro.\n\nOnly **`this`** part is read aloud.')
  await read.unmount()
  const other = await row('row-2')
  expect((await other.find({ type: 'Text' }))?.text).toBe(reply)
  await other.unmount()

  done.open()
  await settle()
  const after = await row('row-1')
  expect((await after.find({ type: 'Text' }))?.text).toBe(reply)
  await after.unmount()
  await menu.unmount()
})

test('orange (the default): the block with the word is drawn with it bold in Claude orange', async ($, on) => {
  const done = gate()
  const reply = 'Intro paragraph stays markdown.\n\nOnly **this** part is read aloud.\n\nLast paragraph too.'
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  on('process.spawn', async function* (): Spawned {
    yield { stream: 'stdout', text: 'pid 42\nword 0\nword 1\nword 2\n' }
    await done.wait
    return { value: { code: 0, signal: null } }
  })

  const menu = await $.ui.mount({
    ...MENU,
    props: { selection: { text: 'Only this part is read', requestId: 'row-1' } },
  })
  await menu.press({ key: 'read-selection' })
  await settle()

  const row = await $.ui.mount({
    plugin: 'paragraph-speaker',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'row-1',
    props: { text: reply, isFirstOfReply: true },
  })
  const texts = await row.findAll({ type: 'Text' })
  const spoken = texts.filter(t => t.props.color === 'claude')
  expect(spoken.map(t => [t.text, t.props.bold])).toEqual([['part', true]])
  // "this" keeps its own bold, not orange
  expect(texts.find(t => t.text === 'this')?.props.bold).toBe(true)
  const blocks = (await row.findAll({ type: 'Markdown' })).map(m => m.props.text)
  expect(blocks).toEqual(['Intro paragraph stays markdown.', 'Last paragraph too.'])
  await row.unmount()

  done.open()
  await settle()
  await menu.unmount()
})

test('a heading and a list being read are spaced and indented as the app lays them out', { timeoutMs: 30_000 }, async ($, on) => {
  const done = gate()
  const reply = 'Intro paragraph stays markdown.\n\n### Steps to take\n\n- first step here\n- second step\n  - inner step\n\nLast paragraph too.'
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  on('process.spawn', async function* (): Spawned {
    yield { stream: 'stdout', text: 'pid 42\nword 4\n' }
    await done.wait
    return { value: { code: 0, signal: null } }
  })
  const menu = await $.ui.mount({
    ...MENU,
    props: { selection: { text: 'Steps to take\nfirst step here\nsecond step\ninner step', requestId: 'row-1' } },
  })
  await menu.press({ key: 'read-selection' })
  await settle()

  const row = await $.ui.mount({
    plugin: 'paragraph-speaker',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'row-1',
    props: { text: reply, isFirstOfReply: true },
  })
  const texts = await row.findAll({ type: 'Text' })
  expect(texts.filter(t => t.props.color === 'claude').map(t => t.text)).toEqual(['step'])
  // The heading is bold body text, with the app's room above (7px for ###) and 4px less under it.
  const boxes = await row.findAll({ type: 'Box' })
  const heading = boxes.find(b => b.props.marginTop === 0.67)
  expect(heading?.props.marginBottom).toBe(-0.38)
  expect(texts.find(t => t.text === 'Steps to take')?.props.bold).toBe(true)
  // List items 8px apart, each bullet in a 20px room a level.
  expect(boxes.filter(b => b.props.marginTop === 'xs').length).toBe(2)
  expect(boxes.filter(b => b.props.alignItems === 'flex-end').map(b => b.props.width)).toEqual([2.4, 2.4, 4.8])
  await row.unmount()

  done.open()
  await settle()
  await menu.unmount()
})

// Each look at a drawing waits about half a second while a reading's stream is open: room for all of them.
test('a second reading after /speak mark bold still marks (the reported sequence)', { timeoutMs: 30_000 }, async ($, on) => {
  const reply = 'Intro.\n\nOnly this part is read aloud.'
  let style: unknown = 'code'
  const gates = [gate(), gate()]
  let runs = 0
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', (_, e) => ({ value: e.key === 'markStyle' ? style : undefined }))
  on('store.set', (_, e) => {
    style = e.value
    return { value: undefined }
  })
  on('process.spawn', async function* (): Spawned {
    const mine = gates[runs++]!
    yield { stream: 'stdout', text: 'pid 42\nword 0\nword 1\n' }
    await mine.wait
    return { value: { code: 0, signal: null } }
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  const drawnRow = async () => {
    const row = await $.ui.mount({
      plugin: 'paragraph-speaker',
      surface: 'desktop',
      component: 'AssistantMessage',
      requestId: 'row-1',
      props: { text: reply, isFirstOfReply: true },
    })
    const text = (await row.find({ type: 'Text' }))?.text
    await row.unmount()
    return text
  }
  const readOnce = async () => {
    const menu = await $.ui.mount({ ...MENU, props: { selection: { text: 'Only this part is read', requestId: 'row-1' } } })
    await menu.press({ key: 'read-selection' })
    await settle()
    await menu.unmount()
  }

  await readOnce()
  expect(await drawnRow()).toBe('Intro.\n\nOnly `this` part is read aloud.')
  gates[0]!.open()
  await settle()
  expect(await drawnRow()).toBe(reply)

  await $.command.run(speak('mark bold'))
  await readOnce()
  expect(await drawnRow()).toBe('Intro.\n\nOnly **this** part is read aloud.')
  gates[1]!.open()
  await settle()
  expect(await drawnRow()).toBe(reply)
})

/** Stand-ins for a Kokoro reading that has spoken `words` and waits at `done`. */
function kokoroSpeaking(on: On, words: number[], done: { wait: Promise<void> }, style?: string) {
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', (_, e) => ({ value: e.key === 'markStyle' ? style : undefined }))
  on('process.spawn', async function* (): Spawned {
    yield { stream: 'stdout', text: `pid 42\n${words.map(w => `word ${w}\n`).join('')}` }
    await done.wait
    return { value: { code: 0, signal: null } }
  })
}

test('the blocks being read are drawn by the mod from the start, so they do not jump as the voice moves', { timeoutMs: 30_000 }, async ($, on) => {
  const done = gate()
  const reply = 'Intro.\n\nFirst read paragraph here.\n\nSecond read paragraph here.\n\nNot selected.'
  kokoroSpeaking(on, [], done) // started, no word spoken yet
  const menu = await $.ui.mount({
    ...MENU,
    props: {
      selection: { text: 'First read paragraph here. Second read paragraph here.' },
      row: { component: 'AssistantMessage', requestId: 'row-1' },
    },
  })
  await menu.press({ key: 'read-selection' })
  await settle()

  const row = await $.ui.mount({
    plugin: 'paragraph-speaker',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'row-1',
    props: { text: reply, isFirstOfReply: true },
  })
  // Both selected paragraphs are already the mod's, nothing marked yet; the rest stays markdown.
  expect((await row.findAll({ type: 'Markdown' })).map(m => m.props.text)).toEqual(['Intro.', 'Not selected.'])
  expect((await row.findAll({ type: 'Text' })).filter(t => t.props.color === 'claude')).toEqual([])
  expect(await row.find({ type: 'Text', text: /Second read paragraph/ })).toBeTruthy()
  await row.unmount()
  done.open()
  await settle()
  await menu.unmount()
})

test('color: orange without bold, so the line keeps its width', async ($, on) => {
  const done = gate()
  kokoroSpeaking(on, [0, 1], done, 'color')
  const menu = await $.ui.mount({
    ...MENU,
    props: { selection: { text: 'Only this part' }, row: { component: 'AssistantMessage', requestId: 'row-1' } },
  })
  await menu.press({ key: 'read-selection' })
  await settle()
  const row = await $.ui.mount({
    plugin: 'paragraph-speaker',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'row-1',
    props: { text: 'Only this part is read.', isFirstOfReply: true },
  })
  const spoken = (await row.findAll({ type: 'Text' })).filter(t => t.props.color === 'claude')
  expect(spoken.map(t => [t.text, t.props.bold ?? false])).toEqual([['this', false]])
  await row.unmount()
  done.open()
  await settle()
  await menu.unmount()
})

test('a command output row and the person’s own message are marked too', { timeoutMs: 30_000 }, async ($, on) => {
  const done = gate()
  const done2 = gate()
  let runs = 0
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  // One stand-in for both readings: hooks beneath the plugin are all set before the first call.
  on('process.spawn', async function* (): Spawned {
    const isFirst = runs++ === 0
    yield { stream: 'stdout', text: isFirst ? 'pid 42\nword 0\nword 1\nword 2\n' : 'pid 43\nword 0\nword 1\n' }
    await (isFirst ? done : done2).wait
    return { value: { code: 0, signal: null } }
  })
  const output = 'paragraph-speaker: Spoken words will be marked as bold from the next reading.'
  const menu = await $.ui.mount({
    ...MENU,
    props: { selection: { text: output }, row: { component: 'CommandOutput', requestId: 'cmd-1' } },
  })
  await menu.press({ key: 'read-selection' })
  await settle()
  const cmd = await $.ui.mount({
    plugin: 'paragraph-speaker',
    surface: 'desktop',
    component: 'CommandOutput',
    requestId: 'cmd-1',
    props: { command: 'speak', args: 'mark bold', text: output, isErrored: false },
  })
  const lit = (await cmd.findAll({ type: 'Text' })).filter(t => t.props.color === 'claude')
  expect(lit.map(t => t.text)).toEqual(['words'])
  await cmd.unmount()
  done.open()
  await settle()
  await menu.unmount()

  const mine = 'please read this message of mine'
  const menu2 = await $.ui.mount({
    ...MENU,
    props: { selection: { text: mine }, row: { component: 'UserMessage', requestId: 'user-1' } },
  })
  await menu2.press({ key: 'read-selection' })
  await settle()
  const user = await $.ui.mount({
    plugin: 'paragraph-speaker',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'user-1',
    props: { text: mine, origin: { kind: 'composer' }, isExpanded: false },
  })
  const lit2 = (await user.findAll({ type: 'Text' })).filter(t => t.props.color === 'claude')
  expect(lit2.map(t => t.text)).toEqual(['read'])
  await user.unmount()
  done2.open()
  await settle()
  await menu2.unmount()
})

/* ── The band above the prompt is OFF (see register.tsx); its test, kept for when it returns:
test('the band above the prompt lights the word being spoken, then goes away', async ($, on) => {
  const done = gate()
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  on('process.spawn', async function* (): Spawned {
    // Pieces arrive as the pipe gives them: a line may be split across two.
    yield { stream: 'stdout', text: 'pid 42\nsentence 0 2\nwo' }
    yield { stream: 'stdout', text: 'rd 0\nword 1\n' }
    await done.wait
    return { value: { code: 0, signal: null } }
  })

  const menu = await $.ui.mount({ ...MENU, props: { selection: { text: 'Only **this** part.' } } })
  await menu.press({ key: 'read-selection' })
  await settle()

  const band = await $.ui.mount(BAND)
  const lit = (await band.findAll({ type: 'Text' })).filter(t => t.props.inverse === true)
  expect(lit.map(t => t.text)).toEqual(['this'])
  expect(await band.find({ type: 'Text', text: /part\./ })).toBeTruthy()
  expect(await band.find({ type: 'Button', key: 'stop' })).toBeTruthy()
  await band.unmount()

  done.open()
  await settle()
  const after = await $.ui.mount(BAND)
  expect(await after.find({ type: 'Button', key: 'stop' })).toBeUndefined()
  await after.unmount()
  await menu.unmount()
})
*/

test('/speak stop ends the Kokoro process at once', async ($, on) => {
  const killed: (readonly string[])[] = []
  const exited = gate()
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  on('process.spawn', async function* (): Spawned {
    yield { stream: 'stdout', text: 'pid 4242\n' }
    await exited.wait // speaking, until it is killed
    return { value: { code: 1, signal: null } }
  })
  on('process.run', (_, e) => {
    killed.push(e.argv)
    exited.open()
    return RAN
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'A long passage.' } } })
  await ui.press({ key: 'read-selection' })
  await settle()
  const stopped = await $.command.run(speak('stop'))
  await settle(() => killed.length > 0)
  await ui.unmount()

  expect(stopped.text).toBe('Stopped.')
  expect(killed).toEqual([['taskkill', '/F', '/T', '/PID', '4242']])
})

test('when Kokoro fails, the system voice reads it and a toast says why', async ($, on) => {
  const spoken: string[] = []
  const toasts: string[] = []
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  on('process.spawn', async function* (): Spawned {
    yield { stream: 'stderr', text: 'Traceback...\nRuntimeError: no audio device\n' }
    return { value: { code: 1, signal: null } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('audio.speak', (_, e) => {
    spoken.push(e.text)
    return { value: { via: 'system' } }
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'Fallback words.' } } })
  await ui.press({ key: 'read-selection' })
  await settle(() => spoken.length > 0)
  await ui.unmount()

  expect(spoken).toEqual(['Fallback words.'])
  expect(toasts).toEqual(['Kokoro voice failed (RuntimeError: no audio device); using the system voice.'])
})

test('/speak voice lists, sets and refuses voices; other options are refused', async ($, on) => {
  const stored: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    stored.push(e.value)
    return { value: undefined }
  })

  const list = await $.command.run(speak('voice'))
  expect(list.text).toMatch(/^Voice: af_heart\. Others: af_bella/)
  const set = await $.command.run(speak('voice am_michael'))
  expect(set.text).toBe('Voice set to am_michael.')
  expect(stored).toEqual(['am_michael'])
  const bad = await $.command.run(speak('voice robot'))
  expect(bad.text).toBe('"robot" is not one of the voices. Type /speak voice to list them.')
  const old = await $.command.run(speak('3'))
  expect(old.text).toBe(
    'Unknown option "3". Use /speak, /speak last, /speak stop, /speak setup, /speak voice <name> or /speak mark orange|color|code|bold.',
  )
})

test('/speak setup runs the setup script, shows its steps, and says when the voice is ready', async ($, on) => {
  const argv: (readonly string[])[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: false })) // no voice installed yet
  on('process.run', (_, e) =>
    e.argv[0] === 'py' ? { value: { ...RAN.value, stdout: '3\r\n' } } : { value: { ...RAN.value, exitCode: 9009 } },
  )
  on('process.spawn', async function* (_, e): Spawned {
    argv.push(e.argv)
    yield { stream: 'stdout', text: 'step 1/4 Finding Python\r\nstep 2/4 Creating' }
    yield { stream: 'stdout', text: ' the Python environment\r\n' }
    yield { stream: 'stdout', text: 'done C:\\L\\paragraph-speaker\r\n' }
    return { value: { code: 0, signal: null } }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const started = await $.command.run(speak('setup'))
  expect(started.text).toMatch(/^Setting up the natural voice/)
  await settle(() => toasts.length > 0)
  expect(argv).toEqual([
    ['py', '-3', '-I', 'C:\\mod\\tts\\setup_voice.py', '--install-dir', 'C:\\L\\paragraph-speaker'],
  ])
  expect(statuses).toEqual(['🔊 Voice setup 1/4 Finding Python…', '🔊 Voice setup 2/4 Creating the Python environment…', undefined])
  expect(toasts).toEqual(['The natural voice is ready. Select text and read it aloud.'])
})

test('/speak setup says why it failed, and does nothing when the voice is there', async ($, on) => {
  const toasts: string[] = []
  let isInstalled = false
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: isInstalled }))
  on('process.run', () => ({ value: { ...RAN.value, stdout: '3\n' } }))
  on('process.spawn', async function* (): Spawned {
    yield { stream: 'stdout', text: 'step 1/4 Finding Python\nerror Python 3.10 to 3.13 was not found.\n' }
    return { value: { code: 1, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.command.run(speak('setup'))
  await settle(() => toasts.length > 0)
  expect(toasts).toEqual(['Voice setup failed: Python 3.10 to 3.13 was not found.'])
  isInstalled = true
  expect((await $.command.run(speak('setup'))).text).toBe('The natural voice is already installed.')
})

test('with nothing selected, /speak says how to select where the session is drawn', async ($, on) => {
  let surfaces: ('terminal' | 'desktop')[] = ['desktop']
  on('ui.selection', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: surfaces }))
  expect((await $.command.run(speak(''))).text).toBe(
    'Nothing selected. Select text in a reply, then right-click → 🔊 Read aloud (or type /speak). Or type /speak last to hear Claude’s latest reply.',
  )
  surfaces = ['terminal']
  expect((await $.command.run(speak(''))).text).toBe(
    'Nothing selected. Select text in a reply with the mouse, then type /speak. (The terminal reports a selection only in its fullscreen layout.) Or type /speak last to hear Claude’s latest reply.',
  )
})

test('without the natural voice, the system voice reads and a toast offers /speak setup once', async ($, on) => {
  const spoken: string[] = []
  const toasts: string[] = []
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mod' } }))
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform: 'windows' } }))
  on('env.get', () => ({ value: 'C:\\L' }))
  on('fs.exists', () => ({ value: false }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.speak', (_, e) => {
    spoken.push(e.text)
    return { value: { via: 'system' } }
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'First words.' } } })
  await ui.press({ key: 'read-selection' })
  await settle(() => spoken.length > 0)
  const again = await $.ui.mount({ ...MENU, props: { selection: { text: 'Second words.' } } })
  await again.press({ key: 'read-selection' })
  await settle(() => spoken.length > 1)
  await ui.unmount()
  await again.unmount()

  expect(spoken).toEqual(['First words.', 'Second words.'])
  expect(toasts).toEqual(['Reading with the system voice. For the natural voice, with each word marked, type /speak setup.'])
})

test('in the terminal, /speak reads the selection and marks it in a table, heading and list', { timeoutMs: 30_000 }, async ($, on) => {
  const done = gate()
  planReading(on, undefined, done)
  const reply = `${PLANS_REPLY}\n\n### Steps to take\n\n- first step here\n  - inner step`
  on('ui.selection', () => ({ value: { text: `${PLANS_COPIED}\nSteps to take\nfirst step here\ninner step`, requestId: 'row-1' } }))
  const row = () =>
    $.ui.mount({
      plugin: 'paragraph-speaker',
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'row-1',
      props: { text: reply, isFirstOfReply: true },
    })
  const seen = await row()
  await seen.unmount()
  const started = await $.command.run(speak(''))
  expect(started.text).toBe('Reading the selected text, its table explained.')
  await settle()

  const drawn = await row()
  const texts = await drawn.findAll({ type: 'Text' })
  expect(texts.filter(t => t.props.color === 'claude').map(t => t.text)).toEqual(['12'])
  expect((await drawn.findAll({ type: 'Box' })).filter(b => b.props.backgroundColor !== undefined).length).toBe(9)
  expect(texts.some(t => t.text === 'Steps to take')).toBe(true)
  await drawn.unmount()
  done.open()
  await settle()
})

test('no selection, no menu row', async $ => {
  const menu = await $.ui.mount({ ...MENU, props: { link: { href: 'https://example.com' } } })
  expect(await menu.find({ type: 'Button' })).toBeUndefined()
  await menu.unmount()
})

test('/speak mark switches between orange, a code box and bold', async ($, on) => {
  const stored: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    stored.push(e.value)
    return { value: undefined }
  })
  expect((await $.command.run(speak('mark'))).text).toBe(
    'Spoken words are marked as orange. Switch with /speak mark orange (bold orange), color (orange, the line never moves), code or bold.',
  )
  expect((await $.command.run(speak('mark bold'))).text).toBe('Spoken words will be marked as bold from the next reading.')
  expect((await $.command.run(speak('mark glow'))).text).toBe('"glow" is not a mark style. Use /speak mark orange, color, code or bold.')
  expect(stored).toEqual(['bold'])
})
