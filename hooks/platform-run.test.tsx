import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On, ProcessSpawnChunk } from 'claude-code'

// The same readings on each system, driven through the engine as a session does.

const MENU = { plugin: 'paragraph-speaker', surface: 'desktop', component: 'ContextMenu' } as const

const speak = (args: string) =>
  ({ command: 'speak', args, origin: { kind: 'composer' }, presentation: {} }) as unknown as CommandRunInput

const RAN = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

type Spawned = AsyncGenerator<ProcessSpawnChunk, { value: { code: number; signal: null } }>

async function settle(isDone: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 1000 && !isDone(); i++) await Promise.resolve()
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {}
  const wait = new Promise<void>(resolve => {
    open = resolve
  })
  return { wait, open }
}

/** A made-up machine: its system, its env, and the mod at `root`. */
function machine(on: On, platform: 'windows' | 'macos' | 'linux', env: Record<string, string>, root: string): void {
  on('session.info', () => ({ value: { transcriptPath: 'session.jsonl', platform } }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: root } }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('store.get', () => ({ value: undefined }))
}

test('macOS: Kokoro runs from Application Support, and stop ends its process group', async ($, on) => {
  const spawned: (readonly string[])[] = []
  const killed: (readonly string[])[] = []
  const exited = gate()
  machine(on, 'macos', { HOME: '/Users/u' }, '/mod')
  on('fs.exists', () => ({ value: true }))
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push(e.argv)
    yield { stream: 'stdout', text: 'pid 4242\n' }
    await exited.wait
    return { value: { code: 1, signal: null } }
  })
  on('process.run', (_, e) => {
    killed.push(e.argv)
    exited.open()
    return RAN
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'Mac words.' } } })
  await ui.press({ key: 'read-selection' })
  await settle(() => spawned.length > 0)
  await settle()
  await $.command.run(speak('stop'))
  await settle(() => killed.length > 0)
  await ui.unmount()

  const home = '/Users/u/Library/Application Support/paragraph-speaker'
  expect(spawned[0]).toEqual([
    `${home}/venv/bin/python`,
    '-I',
    '/mod/tts/kokoro_speak.py',
    '--model',
    `${home}/models/kokoro-v1.0.onnx`,
    '--voices',
    `${home}/models/voices-v1.0.bin`,
    '--voice',
    'af_heart',
  ])
  expect(killed).toEqual([['kill', '-TERM', '--', '-4242']])
})

test('Linux: Kokoro runs from XDG_DATA_HOME when it is set', async ($, on) => {
  const spawned: (readonly string[])[] = []
  machine(on, 'linux', { HOME: '/home/u', XDG_DATA_HOME: '/data/u' }, '/mod')
  on('fs.exists', () => ({ value: true }))
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push(e.argv)
    yield { stream: 'stdout', text: 'pid 7\n' }
    return { value: { code: 0, signal: null } }
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'Linux words.' } } })
  await ui.press({ key: 'read-selection' })
  await settle(() => spawned.length > 0)
  await ui.unmount()

  expect(spawned[0]?.[0]).toBe('/data/u/paragraph-speaker/venv/bin/python')
  expect(spawned[0]?.[2]).toBe('/mod/tts/kokoro_speak.py')
})

test('Linux without Kokoro: the first installed voice program reads, the text on stdin', async ($, on) => {
  const spawned: { argv: readonly string[]; input?: string }[] = []
  machine(on, 'linux', { HOME: '/home/u' }, '/mod')
  on('fs.exists', () => ({ value: false }))
  on('audio.speak', () => {
    throw new Error('no synthesizer')
  })
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push({ argv: e.argv, ...(e.input === undefined ? {} : { input: e.input }) })
    yield { stream: 'stdout', text: 'pid 9\n' }
    // espeak-ng is not installed here: sh says so with 127
    return { value: { code: e.argv[2]!.includes('espeak-ng') ? 127 : 0, signal: null } }
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'Spoken $(touch x) words.' } } })
  await ui.press({ key: 'read-selection' })
  await settle(() => spawned.length > 1)
  await ui.unmount()

  expect(spawned.map(s => s.argv[2])).toEqual(['echo "pid $$"; exec espeak-ng --stdin', 'echo "pid $$"; exec espeak --stdin'])
  expect(spawned.map(s => s.input)).toEqual(['Spoken $(touch x) words.', 'Spoken $(touch x) words.'])
  expect(spawned.some(s => s.argv.some(a => a.includes('words')))).toBe(false)
})

test('Windows without Kokoro: System.Speech reads, the text in an env var', async ($, on) => {
  const spawned: { argv: readonly string[]; env?: Record<string, string> }[] = []
  machine(on, 'windows', { LOCALAPPDATA: 'C:\\L' }, 'C:\\mod')
  on('fs.exists', () => ({ value: false }))
  on('audio.speak', () => {
    throw new Error('no synthesizer')
  })
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push({ argv: e.argv, ...(e.env === undefined ? {} : { env: e.env }) })
    yield { stream: 'stdout', text: 'pid 5\r\n' }
    return { value: { code: 0, signal: null } }
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'Windows words.' } } })
  await ui.press({ key: 'read-selection' })
  await settle(() => spawned.length > 0)
  await ui.unmount()

  expect(spawned[0]?.argv[0]).toBe('powershell')
  expect(spawned[0]?.env).toEqual({ PARAGRAPH_SPEAKER_TEXT: 'Windows words.' })
  expect(spawned[0]?.argv.some(a => a.includes('Windows words'))).toBe(false)
})

test('macOS without Kokoro: say reads, and stop kills it', async ($, on) => {
  const spawned: (readonly string[])[] = []
  const killed: (readonly string[])[] = []
  const exited = gate()
  machine(on, 'macos', { HOME: '/Users/u' }, '/mod')
  on('fs.exists', () => ({ value: false }))
  on('audio.speak', () => {
    throw new Error('no synthesizer')
  })
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push(e.argv)
    yield { stream: 'stdout', text: 'pid 31\n' }
    await exited.wait
    return { value: { code: 0, signal: null } }
  })
  on('process.run', (_, e) => {
    killed.push(e.argv)
    exited.open()
    return RAN
  })

  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'Mac fallback.' } } })
  await ui.press({ key: 'read-selection' })
  await settle(() => spawned.length > 0)
  await settle()
  await $.command.run(speak('stop'))
  await settle(() => killed.length > 0)
  await ui.unmount()

  expect(spawned[0]).toEqual(['sh', '-c', 'echo "pid $$"; exec say'])
  expect(killed).toEqual([['kill', '-TERM', '31']])
})

test('Linux: /speak setup runs setup_voice.py with python3 into ~/.local/share', async ($, on) => {
  const spawned: (readonly string[])[] = []
  const toasts: string[] = []
  machine(on, 'linux', { HOME: '/home/u' }, '/mod')
  on('fs.exists', () => ({ value: false }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { ...RAN.value, stdout: '3\n' } }))
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push(e.argv)
    yield { stream: 'stdout', text: 'done /home/u/.local/share/paragraph-speaker\n' }
    return { value: { code: 0, signal: null } }
  })

  await $.command.run(speak('setup'))
  await settle(() => toasts.length > 0)
  expect(spawned).toEqual([
    ['python3', '-I', '/mod/tts/setup_voice.py', '--install-dir', '/home/u/.local/share/paragraph-speaker'],
  ])
  expect(toasts).toEqual(['The natural voice is ready. Select text and read it aloud.'])
})

test('/speak setup without any Python says how to get one, and starts nothing', async ($, on) => {
  const spawned: (readonly string[])[] = []
  machine(on, 'linux', { HOME: '/home/u' }, '/mod')
  on('fs.exists', () => ({ value: false }))
  on('process.run', () => {
    throw new Error('not found')
  })
  on('process.spawn', async function* (_, e): Spawned {
    spawned.push(e.argv)
    return { value: { code: 0, signal: null } }
  })

  const said = await $.command.run(speak('setup'))
  expect(said.text).toBe('Python 3 was not found. Install Python 3.12 from https://www.python.org/downloads/ and run /speak setup again.')
  expect(spawned).toEqual([])
})

test('/speak last reads the newest reply, where no selection can be made', async ($, on) => {
  const inputs: string[] = []
  machine(on, 'linux', { HOME: '/home/u' }, '/mod')
  on('fs.exists', () => ({ value: true }))
  on('process.spawn', async function* (_, e): Spawned {
    inputs.push(e.input ?? '')
    yield { stream: 'stdout', text: 'pid 3\n' }
    return { value: { code: 0, signal: null } }
  })
  const row = (requestId: string, text: string) =>
    $.ui.mount({
      plugin: 'paragraph-speaker',
      surface: 'vscode',
      component: 'AssistantMessage',
      requestId,
      props: { text, isFirstOfReply: true },
    })

  expect((await $.command.run(speak('last'))).text).toBe('There is no reply to read yet.')
  const older = await row('r1', 'The older reply.')
  const newer = await row('r2', 'The **newer** reply.')
  await older.unmount()
  const again = await row('r1', 'The older reply.') // a redraw of an older row
  const said = await $.command.run(speak('last'))
  await settle(() => inputs.length > 0)
  for (const ui of [newer, again]) await ui.unmount()

  expect(said.text).toBe('Reading the latest reply.')
  expect(inputs).toEqual(['The newer reply.'])
})
