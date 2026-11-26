import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReadingTarget, ReadingView, TableRef } from '../types'
import {
  NO_SPAN,
  align,
  blockLines,
  blocksOf,
  gridTable,
  markWord,
  numberedTable,
  parseExplanation,
  plainLines,
  readTableParts,
  tablesOf,
} from './mark'
import type { CellRef, ExplanationPart, GridCell, GridTable, Line, MarkStyle, Piece, Span } from './mark'

// ── Diagnostics: what each reading did, in debug.log in the voice's install folder ──
// Off; set DEBUG to true to write the log again when something needs finding out.
// Lines are noted anywhere (drawing included) and written from outside drawing.
const DEBUG = false
const DEBUG_KEEP = 400
const debugLines: string[] = []
let debugFile: string | undefined

function note(line: string): void {
  if (!DEBUG) return
  debugLines.push(`${new Date().toISOString().slice(11, 23)} ${line}`)
  if (debugLines.length > DEBUG_KEEP) debugLines.splice(0, debugLines.length - DEBUG_KEEP)
}

async function flushNotes($: EngineInterface): Promise<void> {
  if (!DEBUG) return
  try {
    if (debugFile === undefined) {
      const platform = await platformOf($)
      const home = (await homesHere($, platform))[0]
      if (home === undefined) return
      debugFile = joinPath(platform, home, 'debug.log')
    }
    await $.fs.write(debugFile, debugLines.join('\n') + '\n')
  } catch {
    // diagnostics never get in the way of reading
  }
}

/** A short, one-line look at a text, for the notes. */
const peek = (text: string) => JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)

/** The old "Speak reply" pane's id: closed at start, the pane is gone. */
const OLD_PANE = 'paragraph-speaker'

/** The words being read and the one being spoken: changes with every word. */
const reading = atom(
  { plugin: 'paragraph-speaker', key: 'reading' } as const,
  null as ReadingView | null,
  { shape: 'reading-2' },
)
/**
 * Which reply the words are marked in: changes once per reading, so every
 * reply row can read it without being redrawn at each word. Only the row the
 * words are found in reads `reading` too.
 */
const target = atom(
  { plugin: 'paragraph-speaker', key: 'target' } as const,
  null as ReadingTarget | null,
  { shape: 'target-1' },
)

const MARK_STYLES = ['orange', 'color', 'code', 'bold'] as const
const DEFAULT_MARK: MarkStyle = 'orange'
/** The store key of the chosen style (a new key: orange is the new default). */
const MARK_KEY = 'markStyle'

async function chosenMark($: EngineInterface): Promise<MarkStyle> {
  const stored = await $.store.get(MARK_KEY)
  return (MARK_STYLES as readonly unknown[]).includes(stored) ? (stored as MarkStyle) : DEFAULT_MARK
}

/** Rows the notes already described for the reading under way, so each is described once. */
const notedRows = new Set<string>()

/**
 * How one run of a hand-drawn block looks: the spoken word in Claude's orange
 * (bold, for `orange`). In a table's cell (`isCell`), already bold in a header,
 * the code style inverts the cell's text and the bold style underlines it too.
 */
function pieceLook(p: Piece, style: MarkStyle, isCell = false) {
  const isSpokenBold = p.isSpoken === true && (style === 'orange' || style === 'bold')
  const isSpokenOrange = p.isSpoken === true && (style === 'orange' || style === 'color')
  const isSpokenCode = p.isSpoken === true && style === 'code'
  return {
    ...(p.isBold || isSpokenBold ? { bold: true } : {}),
    ...(p.isItalic ? { italic: true } : {}),
    ...(p.isCode || (isSpokenCode && !isCell) ? { mono: true } : {}),
    ...(p.isStrike ? { strikethrough: true } : {}),
    ...(p.isLink || (isCell && p.isSpoken === true && style === 'bold') ? { underline: true } : {}),
    ...(isSpokenOrange ? { color: 'claude' } : {}),
    ...(isCell && isSpokenCode ? { inverse: true } : {}),
  }
}

/** What a row is drawn as during a reading: the app's own, its text rewritten, or by the mod. */
type Part =
  | { kind: 'markdown'; text: string }
  | { kind: 'lines'; lines: Line[] }
  | { kind: 'table'; grid: GridTable }

// The app's own reply layout, so what the mod draws in its place takes the
// same room. A Box's spacing counts down in half lines (10.5px, the gap the
// app leaves between blocks) and across in `ch`; `xs` is 8px.
/** A table's cell shading: the app's 5% (cells) and 10% (header) tint, in a gray that reads in light and dark. */
const CELL_SHADE = 'rgba(128, 128, 128, 0.12)'
const HEADER_SHADE = 'rgba(128, 128, 128, 0.24)'
/** The 2px the app's table leaves between and around its cells. */
const CELL_SPACING_DOWN = 0.2
const CELL_SPACING_ACROSS = 0.25
/** The app indents a list 20px a level, its bullet or number in that room. */
const LIST_INDENT = 2.4
/** Room the app adds above a heading (12px, 10px, 7px for #, ##, ###) and takes back under it (4px). */
const HEADING_ABOVE = [0, 1.14, 0.95, 0.67, 0, 0, 0]
const HEADING_BELOW = -0.38

/** The room above a hand-drawn line, after the line before it in the same block, as the app spaces them. */
function roomAbove(before: Line | undefined, line: Line): number | 'xs' {
  if (before === undefined) return 0
  if (before.item !== undefined && line.item !== undefined) return 'xs'
  const above = line.isHeading ? (HEADING_ABOVE[line.level ?? 0] ?? 0) : 0
  const under = before.isHeading && (before.level ?? 9) <= 3 ? HEADING_BELOW : 0
  return 1 + above + under
}
type Decision =
  | { kind: 'pass' }
  | { kind: 'rewrite'; text: string }
  | { kind: 'draw'; parts: Part[]; style: MarkStyle }
const PASS: Decision = { kind: 'pass' }

/**
 * How a transcript row draws while a reading is on: untouched when the words
 * are not in it; for the code and bold styles its markdown with the word
 * marked; for orange and color (and always for plain text) the blocks the
 * selection covers drawn by the mod for the whole reading, so they switch
 * look once at its start and once at its end, not as the voice moves on.
 */
async function decide(
  $: EngineInterface,
  rowId: string,
  text: string,
  isMarkdown: boolean,
  isSummary: boolean,
): Promise<Decision> {
  rememberRow(rowId, text, isMarkdown)
  const goal = await read($, target)
  if (goal === null || isSummary) return PASS
  const rowKey = `${goal.id}:${rowId}`
  if (goal.rowId !== undefined && goal.rowId !== rowId) {
    if (!notedRows.has(rowKey)) {
      notedRows.add(rowKey)
      note(`row ${rowId}: passed over, the selection is in row ${goal.rowId}`)
    }
    return PASS
  }
  const key = `${rowKey}:${text.length}`
  let spans = alignments.get(key)
  if (spans === undefined) {
    const skip = new Set((goal.skip ?? []).flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i)))
    spans = align(text, goal.words, skip)
    alignments.set(key, spans)
    note(
      spans === null
        ? `row ${rowId}: the words are not in it (it starts ${peek(text)})`
        : `row ${rowId}: ${spans.filter(Boolean).length} of ${goal.words.length} words found`,
    )
  }
  const view = await read($, reading)
  const current = view !== null ? view.current : -1

  // Tables read as explanations: drawn by the mod in fixed-width text for the
  // whole reading, the cells the part being spoken is about marked.
  const tablesRead = isMarkdown ? [...new Set((goal.tableRefs ?? []).map(r => r.table))] : []
  const tables = tablesRead.length > 0 ? tablesOf(text).filter(t => tablesRead.includes(t.start)) : []
  const active = goal.tableRefs?.find(r => current >= r.from && current < r.to)

  if (spans === null && tables.length === 0) return PASS
  const found = spans ?? []
  const span = current >= 0 ? found[current] : undefined

  if (!isMarkdown) {
    return { kind: 'draw', parts: [{ kind: 'lines', lines: plainLines(text, span ?? NO_SPAN) }], style: goal.style }
  }
  const isMarkdownStyle = goal.style === 'code' || goal.style === 'bold'
  if (isMarkdownStyle && tables.length === 0) {
    if (span === undefined || span.isUnmarkable) return PASS
    return { kind: 'rewrite', text: markWord(text, span, goal.style === 'code' ? 'code' : 'bold') }
  }
  const blocks = blocksOf(text)
  const isTable = (b: { start: number }) => tables.some(t => t.start === b.start)
  const isRead = (b: { start: number; end: number }) =>
    isTable(b) || found.some(s => s !== undefined && s.start >= b.start && s.end <= b.end)
  const first = blocks.findIndex(isRead)
  const last = blocks.findLastIndex(isRead)
  if (first < 0) return PASS
  const parts: Part[] = []
  const before = text.slice(0, blocks[first]!.start).trimEnd()
  if (before !== '') parts.push({ kind: 'markdown', text: before })
  for (const block of blocks.slice(first, last + 1)) {
    const blockText = text.slice(block.start, block.end)
    if (isTable(block)) {
      const cells = active !== undefined && active.table === block.start ? active.cells : []
      parts.push({ kind: 'table', grid: gridTable(blockText, cells) })
      continue
    }
    if (isMarkdownStyle) {
      // code and bold: the app's own markdown for each block, the word marked in it
      const isHere = span !== undefined && !span.isUnmarkable && span.start >= block.start && span.end <= block.end
      const shifted = isHere ? { ...span, start: span.start - block.start, end: span.end - block.start } : undefined
      const style = goal.style === 'code' ? 'code' : 'bold'
      parts.push({ kind: 'markdown', text: shifted === undefined ? blockText : markWord(blockText, shifted, style) })
      continue
    }
    const lines = blockLines(text, block, span ?? NO_SPAN)
    parts.push(lines === null ? { kind: 'markdown', text: blockText } : { kind: 'lines', lines })
  }
  const after = text.slice(blocks[last]!.end).trimStart()
  if (after !== '') parts.push({ kind: 'markdown', text: after })
  return { kind: 'draw', parts, style: goal.style }
}

type DrawElements = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Markdown' | 'Text'>

/**
 * A row drawn by the mod: markdown where the app draws it best, the blocks
 * being read drawn to take the room the app gives them, the gap between
 * blocks the app's own, so nothing moves when the reading starts or ends.
 */
function drawParts({ Box, Markdown, Text }: DrawElements, d: Extract<Decision, { kind: 'draw' }>) {
  return (
    <Box flexDirection="column" gap={1}>
      {d.parts.map((part, i) =>
        part.kind === 'markdown' ? (
          <Markdown text={part.text} />
        ) : part.kind === 'table' ? (
          drawTable({ Box, Text }, part.grid, d.style)
        ) : (
          drawLines({ Box, Text }, part.lines, d.style, i === 0)
        ),
      )}
    </Box>
  )
}

/** One line's (or cell's) runs, each in its look. */
function drawRuns({ Text }: Pick<DrawElements, 'Text'>, pieces: Piece[], style: MarkStyle, isCell = false) {
  return pieces.map(p => <Text {...pieceLook(p, style, isCell)}>{p.text}</Text>)
}

/**
 * A table drawn as the app draws its own: full width, each cell shaded with
 * 8px of padding and 2px between cells, the header shaded deeper and bold, the
 * columns as wide as the app makes them. It takes the app's table's room, and
 * a marked cell only changes color: its column keeps its width.
 */
function drawTable({ Box, Text }: Pick<DrawElements, 'Box' | 'Text'>, grid: GridTable, style: MarkStyle) {
  const row = (cells: GridCell[], isHeader: boolean) => (
    <Box flexDirection="row" columnGap={CELL_SPACING_ACROSS}>
      {cells.map((cell, c) => {
        const align = grid.aligns[c]
        return (
          <Box
            width={grid.widths[c]}
            flexDirection="column"
            padding="sm"
            backgroundColor={isHeader ? HEADER_SHADE : CELL_SHADE}
            {...(align === 'right' ? { alignItems: 'flex-end' as const } : align === 'center' ? { alignItems: 'center' as const } : {})}
          >
            <Text>{drawRuns({ Text }, cell.pieces, style, true)}</Text>
          </Box>
        )
      })}
    </Box>
  )
  const rows = [...(grid.header !== null ? [row(grid.header, true)] : []), ...grid.rows.map(cells => row(cells, false))]
  return (
    <Box
      flexDirection="column"
      width="100%"
      rowGap={CELL_SPACING_DOWN}
      paddingY={CELL_SPACING_DOWN}
      paddingX={CELL_SPACING_ACROSS}
    >
      {rows}
    </Box>
  )
}

/**
 * A block's lines spaced as the app spaces them: 8px between list items, a
 * list indented 20px a level with its bullet or number in that room, room above
 * a heading and a little less under it. Headings are the body size in bold:
 * the app's ### exactly, its # and ## a touch smaller but as tall.
 */
function drawLines({ Box, Text }: Pick<DrawElements, 'Box' | 'Text'>, lines: Line[], style: MarkStyle, isFirst: boolean) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const above = i === 0 ? (line.isHeading && !isFirst ? (HEADING_ABOVE[line.level ?? 0] ?? 0) : 0) : roomAbove(lines[i - 1], line)
        const below = i === lines.length - 1 && line.isHeading && (line.level ?? 9) <= 3 ? HEADING_BELOW : 0
        const room = { ...(above !== 0 ? { marginTop: above } : {}), ...(below !== 0 ? { marginBottom: below } : {}) }
        const text = (
          <Text {...(line.isHeading ? { bold: true } : {})} {...(line.isQuote ? { dimColor: true } : {})}>
            {line.item === undefined ? line.prefix : line.isQuote ? '│ ' : ''}
            {drawRuns({ Text }, line.pieces, style)}
          </Text>
        )
        if (line.item === undefined) return <Box {...room}>{text}</Box>
        return (
          <Box flexDirection="row" {...room}>
            <Box width={LIST_INDENT * (line.item.depth + 1)} flexShrink={0} alignItems="flex-end" paddingRight={0.6}>
              <Text>{line.item.marker}</Text>
            </Box>
            <Box flexShrink={1}>{text}</Box>
          </Box>
        )
      })}
    </Box>
  )
}

/** Where each reading's words sit in each reply row, worked out once per row and reading. */
const alignments = new Map<string, (Span | undefined)[] | null>()
let readings = 0

/**
 * Which words fit on one row of `columns` characters around the spoken one:
 * it sits about a third of the way in, so the words coming next show.
 */
export function windowAround(words: string[], current: number, columns: number): { start: number; end: number } {
  const at = Math.min(Math.max(0, current), words.length - 1)
  const width = (i: number) => words[i]!.length + 1
  let used = width(at)
  let start = at
  let end = at
  const lead = Math.floor(columns / 3)
  while (start > 0 && used + width(start - 1) <= lead + width(at)) used += width(--start)
  while (end < words.length - 1 && used + width(end + 1) <= columns) used += width(++end)
  while (start > 0 && used + width(start - 1) <= columns) used += width(--start)
  return { start, end }
}

/**
 * Turns markdown into plain words a synthesizer reads well, single-spaced.
 * Every line ends in punctuation, a full stop added where it has none (a list
 * item, a heading), so the voice pauses there instead of running into the next.
 */
export function toSpeech(md: string): string {
  return md
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`|]+/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line !== '')
    .map(line => (/[.!?:;,…]["'”’)\]]*$/.test(line) ? line : `${line}.`))
    .join(' ')
}

/** The last text each row was drawn with, so a reading can go back to a reply's markdown. */
const rowTexts = new Map<string, { text: string; isMarkdown: boolean }>()
const ROW_TEXTS_KEEP = 500

function rememberRow(rowId: string, text: string, isMarkdown: boolean): void {
  rowTexts.delete(rowId)
  rowTexts.set(rowId, { text, isMarkdown })
  if (rowTexts.size > ROW_TEXTS_KEEP) rowTexts.delete(rowTexts.keys().next().value!)
}

const TABLE_EXPLAINER = [
  'You explain a table to someone who is listening to it while it is shown on their screen.',
  'Reply with JSON only, in this shape: {"parts":[{"say":"...","refs":[{"row":1,"col":2}]}]}',
  'Each part is one or two spoken sentences. "say" is plain spoken text: no markdown, no lists, no symbols such as | or *.',
  '"refs" names what that part talks about, so it can be highlighted while it is spoken:',
  '{"row":r,"col":c} for one cell, {"row":r} for a whole row, {"col":c} for a whole column, [] when the part is about the table as a whole.',
  'Use the row and column numbers shown with the table (row 0 is the header).',
  'First say in one part what the table shows. Then walk the listener through it:',
  'compare the rows and columns that matter, keeping the names, numbers and units that carry the meaning.',
  'End with the main takeaway when there is one. Use the language the table is written in.',
  'Keep it comfortable to listen to: about 60 to 150 words in all, more only for a large table.',
].join(' ')

/** Spoken explanations already made, by table text: a table is explained once. */
const explained = new Map<string, ExplanationPart[]>()

/**
 * A table as a spoken explanation in parts, each naming the cells it talks
 * about, from a small fast model; read row by row (each row marked) when the
 * model can't be asked. `before`: the text just above the table, which usually
 * says what it is about.
 */
async function explainTable($: EngineInterface, table: string, before: string): Promise<ExplanationPart[]> {
  const known = explained.get(table)
  if (known !== undefined) return known
  let parts = readTableParts(table, toSpeech)
  try {
    const answer = await $.model.complete({
      model: 'haiku',
      system: TABLE_EXPLAINER,
      prompt: `The text just before the table:\n${before}\n\nThe table, its rows and columns numbered:\n${numberedTable(table)}`,
      maxTokens: 1200,
      timeoutMs: 30_000,
    })
    if (answer.isAnswered && answer.text.trim() !== '') {
      const parsed = parseExplanation(answer.text, table)
      if (parsed !== null) parts = parsed.map(p => ({ ...p, say: toSpeech(p.say) }))
      else if (!answer.text.includes('{')) parts = [{ say: toSpeech(answer.text), refs: [] }]
      else note('table: the explanation was not the JSON asked for, read row by row')
    } else {
      note(`table: no explanation (${answer.isAnswered ? 'empty' : answer.reason}), read row by row`)
    }
  } catch (error) {
    note(`table: no explanation (${String(error)}), read row by row`)
  }
  explained.set(table, parts)
  return parts
}

/**
 * What to say for a selection: its text as copied, or, when it takes in a
 * table of a reply whose markdown is known, that markdown with each table
 * swapped for its spoken explanation. `skip`: the words of the explanations,
 * which are not on screen and so are never marked.
 */
async function speechFor(
  $: EngineInterface,
  selected: string,
  rowId: string | undefined,
): Promise<{ text: string; skip: [number, number][]; tableRefs: TableRef[]; tables: number }> {
  const plain = toSpeech(selected)
  const asCopied = { text: plain, skip: [], tableRefs: [], tables: 0 }
  const row = rowId === undefined ? undefined : rowTexts.get(rowId)
  if (row === undefined || !row.isMarkdown) return asCopied
  const md = row.text
  const spans = align(md, plain.split(' '))?.filter(s => s !== undefined)
  if (spans === undefined || spans.length === 0) return asCopied
  const tables = tablesOf(md).filter(t => t.start < spans.at(-1)!.end && t.end > spans[0]!.start)
  if (tables.length === 0) return asCopied

  // From the markdown: the selected range, widened to take whole tables.
  const start = Math.min(spans[0]!.start, tables[0]!.start)
  const end = Math.max(spans.at(-1)!.end, tables.at(-1)!.end)
  void Promise.resolve($.ui.toast(tables.length === 1 ? 'Explaining the table…' : `Explaining ${tables.length} tables…`)).catch(
    () => undefined,
  )
  // Each piece: text read as it stands, or a part of a table's explanation with the cells it is about.
  const pieces: { text: string; about?: { table: number; cells: CellRef[] } }[] = []
  let at = start
  for (const table of tables) {
    pieces.push({ text: toSpeech(md.slice(at, table.start)) })
    const text = md.slice(table.start, table.end)
    for (const part of await explainTable($, text, md.slice(Math.max(0, table.start - 800), table.start))) {
      pieces.push({ text: part.say, about: { table: table.start, cells: part.refs } })
    }
    at = table.end
  }
  pieces.push({ text: toSpeech(md.slice(at, end)) })

  const words: string[] = []
  const skip: [number, number][] = []
  const tableRefs: TableRef[] = []
  for (const piece of pieces) {
    const these = piece.text.split(' ').filter(w => w !== '')
    if (piece.about !== undefined) {
      const range: [number, number] = [words.length, words.length + these.length]
      skip.push(range)
      if (piece.about.cells.length > 0) tableRefs.push({ from: range[0], to: range[1], ...piece.about })
    }
    words.push(...these)
  }
  return { text: words.join(' '), skip, tableRefs, tables: tables.length }
}

/** Kokoro's English voices: a = American, b = British; f = female, m = male. */
export const VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'af_nova', 'af_alloy',
  'af_aoede', 'af_jessica', 'af_kore', 'af_river',
  'am_michael', 'am_fenrir', 'am_puck', 'am_adam', 'am_echo', 'am_eric', 'am_liam', 'am_onyx',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily',
  'bm_george', 'bm_fable', 'bm_daniel', 'bm_lewis',
] as const
const DEFAULT_VOICE = 'af_heart'

/** The systems the mod knows; WSL counts as Linux. */
export type Platform = 'windows' | 'macos' | 'linux'

/** The system the engine runs on: the session's own word, else uname's. */
async function platformOf($: EngineInterface): Promise<Platform> {
  try {
    const { platform } = await $.session.info()
    if (platform === 'windows' || platform === 'macos') return platform
    if (platform === 'linux' || platform === 'wsl') return 'linux'
  } catch {
    // asked again below
  }
  const { sysname } = await $.session.machine()
  return sysname === 'Windows_NT' ? 'windows' : sysname === 'Darwin' ? 'macos' : 'linux'
}

/** Joins path parts with the system's separator. */
export function joinPath(platform: Platform, ...parts: string[]): string {
  const sep = platform === 'windows' ? '\\' : '/'
  return parts
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((part, i) => i === 0 || part !== '')
    .join(sep)
}

/** The environment variables that decide where the voice is installed. */
export type HomeEnv = { LOCALAPPDATA?: string | undefined; HOME?: string | undefined; XDG_DATA_HOME?: string | undefined }

/**
 * Where the voice is installed, the first the one setup writes to. On Windows
 * the Claude app is a packaged app, so what it writes under AppData\Local
 * lands under Packages\Claude_...\LocalCache: both spellings are tried.
 */
export function installHomes(platform: Platform, env: HomeEnv): string[] {
  if (platform === 'windows') {
    if (!env.LOCALAPPDATA) return []
    return [
      joinPath(platform, env.LOCALAPPDATA, 'paragraph-speaker'),
      joinPath(platform, env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local', 'paragraph-speaker'),
    ]
  }
  if (platform === 'macos') return env.HOME ? [joinPath(platform, env.HOME, 'Library', 'Application Support', 'paragraph-speaker')] : []
  // XDG says a relative XDG_DATA_HOME is to be ignored.
  if (env.XDG_DATA_HOME?.startsWith('/')) return [joinPath(platform, env.XDG_DATA_HOME, 'paragraph-speaker')]
  return env.HOME ? [joinPath(platform, env.HOME, '.local', 'share', 'paragraph-speaker')] : []
}

async function homesHere($: EngineInterface, platform: Platform): Promise<string[]> {
  if (platform === 'windows') return installHomes(platform, { LOCALAPPDATA: await $.env.get('LOCALAPPDATA') })
  return installHomes(platform, { HOME: await $.env.get('HOME'), XDG_DATA_HOME: await $.env.get('XDG_DATA_HOME') })
}

/** The Python inside the voice's own environment. */
export function venvPython(platform: Platform, home: string): string {
  return platform === 'windows' ? joinPath(platform, home, 'venv', 'Scripts', 'python.exe') : joinPath(platform, home, 'venv', 'bin', 'python')
}

/**
 * The command that ends process `pid` and what it started. On macOS and Linux
 * the Kokoro script leads its own process group (`isGroup`), its player in it.
 */
export function stopCommand(platform: Platform, pid: string, isGroup: boolean): string[] {
  if (platform === 'windows') return ['taskkill', '/F', '/T', '/PID', pid]
  return isGroup ? ['kill', '-TERM', '--', `-${pid}`] : ['kill', '-TERM', pid]
}

/**
 * A system voice to read with when Kokoro is not there. Each first writes
 * `pid <n>` so it can be stopped; the text goes in through stdin or an env
 * var, never on the command line. `cancel` also stops a speech daemon.
 */
export type SystemVoice = { name: string; argv: string[]; textVia: 'stdin' | 'env'; cancel?: string[] }

/** The text's env var for a voice that takes it by `env`. */
export const TEXT_VAR = 'PARAGRAPH_SPEAKER_TEXT'

/** Exit code of `sh` when the program it was to run is not installed. */
const NOT_FOUND = 127

/** The system voices to try, in order, after the engine's own synthesizer. */
export function systemVoices(platform: Platform): SystemVoice[] {
  const sh = (program: string): string[] => ['sh', '-c', `echo "pid $$"; exec ${program}`]
  if (platform === 'windows') {
    return [
      {
        name: 'Windows voice',
        argv: [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Write-Output "pid $PID"; Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:${TEXT_VAR})`,
        ],
        textVia: 'env',
      },
    ]
  }
  if (platform === 'macos') return [{ name: 'say', argv: sh('say'), textVia: 'stdin' }]
  return [
    { name: 'espeak-ng', argv: sh('espeak-ng --stdin'), textVia: 'stdin' },
    { name: 'espeak', argv: sh('espeak --stdin'), textVia: 'stdin' },
    { name: 'spd-say', argv: sh('spd-say --wait --pipe-mode'), textVia: 'stdin', cancel: ['spd-say', '--cancel'] },
  ]
}

/** The Pythons that may run the setup script, in order. */
export function setupPythons(platform: Platform): string[][] {
  return platform === 'windows' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]
}

type KokoroInstall = {
  platform: Platform
  home: string
  python: string
  model: string
  voices: string
  script: string
}

/** Finds the Kokoro install, or undefined: then a system voice speaks. */
async function findKokoro($: EngineInterface): Promise<KokoroInstall | undefined> {
  try {
    return await lookForKokoro($)
  } catch {
    return undefined
  }
}

async function lookForKokoro($: EngineInterface): Promise<KokoroInstall | undefined> {
  const root = (await $.process.hookEnv()).CLAUDE_PLUGIN_ROOT
  if (!root) return undefined
  const platform = await platformOf($)
  for (const home of await homesHere($, platform)) {
    const install: KokoroInstall = {
      platform,
      home,
      python: venvPython(platform, home),
      model: joinPath(platform, home, 'models', 'kokoro-v1.0.onnx'),
      voices: joinPath(platform, home, 'models', 'voices-v1.0.bin'),
      script: joinPath(platform, root, 'tts', 'kokoro_speak.py'),
    }
    const found = await Promise.all([install.python, install.model, install.voices, install.script].map(p => $.fs.exists(p)))
    if (found.every(Boolean)) return install
  }
  return undefined
}

async function chosenVoice($: EngineInterface): Promise<string> {
  const stored = await $.store.get('voice')
  return typeof stored === 'string' && (VOICES as readonly string[]).includes(stored) ? stored : DEFAULT_VOICE
}

/** The reading under way: `stop` ends it at once, whichever voice speaks. */
type Run = { isStopped: boolean; stop: () => void }
let current: Run | undefined

/** `rowId`: the transcript row the selection lies in, when one is known. */
async function speakSelection(
  $: EngineInterface,
  selected: string | undefined,
  rowId?: string,
  what = 'the selected text',
): Promise<string> {
  if (toSpeech(selected ?? '') === '') return 'Select some words in a reply first.'
  current?.stop() // a reading under way stops now, not after an explanation is ready
  const { text, skip, tableRefs, tables } = await speechFor($, selected ?? '', rowId)
  await speakText($, text, rowId, skip, tableRefs)
  return tables === 0 ? `Reading ${what}.` : `Reading ${what}, ${tables === 1 ? 'its table' : `its ${tables} tables`} explained.`
}

async function speakText(
  $: EngineInterface,
  text: string,
  rowId?: string,
  skip: [number, number][] = [],
  tableRefs: TableRef[] = [],
): Promise<void> {
  current?.stop()
  const run: Run = { isStopped: false, stop: () => { run.isStopped = true } }
  current = run
  const words = text.split(' ')
  alignments.clear()
  notedRows.clear()
  const style = await chosenMark($)
  const id = ++readings
  note(`read #${id}: ${words.length} words, row=${rowId ?? '(any)'}, style=${style}, text ${peek(text)}`)
  await update($, target, () => ({
    id,
    words,
    style,
    ...(rowId === undefined ? {} : { rowId }),
    ...(skip.length === 0 ? {} : { skip }),
    ...(tableRefs.length === 0 ? {} : { tableRefs }),
  }))
  await update($, reading, () => ({ words, current: -1, voice: 'kokoro' as const }))
  await flushNotes($)
  void (async () => {
    try {
      const kokoro = await findKokoro($)
      note(kokoro === undefined ? `read #${id}: no Kokoro found, system voice` : `read #${id}: Kokoro at ${kokoro.home}`)
      if (kokoro !== undefined && !run.isStopped) {
        const failed = await speakWithKokoro($, kokoro, text, run)
        if (failed === undefined || run.isStopped) return
        await $.ui.toast(`Kokoro voice failed (${failed}); using the system voice.`)
      }
      if (run.isStopped) return
      if (kokoro === undefined && !hasHintedSetup && !isSettingUp) {
        hasHintedSetup = true
        void Promise.resolve(
          $.ui.toast('Reading with the system voice. For the natural voice, with each word marked, type /speak setup.'),
        ).catch(() => undefined)
      }
      // 'windows' is the state's name for any system voice: it marks no words.
      await update($, reading, view => view && { ...view, current: -1, voice: 'windows' as const })
      const spoke = await speakWithSystem($, text, run)
      if (!spoke && !run.isStopped) {
        await $.ui.toast(
          (await platformOf($)) === 'linux'
            ? 'No voice found. Install espeak-ng (or speech-dispatcher), or type /speak setup for the natural voice.'
            : 'No voice found. Type /speak setup for the natural voice.',
        )
      }
    } catch (error) {
      note(`read #${id}: failed: ${String(error)}`)
      if (!run.isStopped) await $.ui.toast(`Could not speak: ${String(error)}`)
    } finally {
      const isLatest = current === run
      note(`read #${id}: ended${run.isStopped ? ' (stopped)' : ''}${isLatest ? '' : ' (a newer reading took over)'}`)
      if (isLatest) {
        current = undefined
        await update($, reading, () => null)
        await update($, target, () => null)
      }
      await flushNotes($)
    }
  })()
}

/** Speaks with Kokoro, following its word reports; undefined when done or stopped, else why it failed. */
async function speakWithKokoro(
  $: EngineInterface,
  kokoro: KokoroInstall,
  text: string,
  run: Run,
): Promise<string | undefined> {
  const voice = await chosenVoice($)
  // `-I` keeps Python from loading anything from the current or script folder.
  const child = $.process.spawn({
    argv: [kokoro.python, '-I', kokoro.script, '--model', kokoro.model, '--voices', kokoro.voices, '--voice', voice],
    cwd: kokoro.home,
    input: text,
  })
  let pid: string | undefined
  let pending = ''
  let stderr = ''
  // The script names its process first; Stop ends that process (and its player), which ends the sound.
  const kill = () => {
    if (pid !== undefined) void $.process.run(stopCommand(kokoro.platform, pid, true)).catch(() => undefined)
  }
  run.stop = () => {
    run.isStopped = true
    kill()
  }
  let heard = 0
  for await (const { stream, text: piece } of child) {
    if (stream === 'stderr') {
      stderr += piece
      continue
    }
    pending += piece
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const [kind, a] = line.trim().split(' ')
      if (kind === 'pid' && pid === undefined) {
        pid = a
        note(`kokoro: process ${pid}, voice ${voice}`)
        await flushNotes($)
        if (run.isStopped) kill()
      } else if (kind === 'word' && !run.isStopped) {
        heard += 1
        await update($, reading, view => view && { ...view, current: Number(a) })
        if (heard === 1) {
          note('kokoro: first word spoken')
          await flushNotes($)
        }
      }
    }
  }
  note(`kokoro: ${heard} words spoken${run.isStopped ? ', stopped' : ''}`)
  if (run.isStopped) return undefined
  const ended = await child.result
  note(`kokoro: exit code ${ended.code}${stderr.trim() === '' ? '' : `, last error line ${peek(stderr.trim().split(/\r?\n/).at(-1) ?? '')}`}`)
  if (ended.code === 0) return undefined
  return stderr.trim().split(/\r?\n/).at(-1) || `exit code ${ended.code}`
}

/**
 * The system's own voice: the engine's synthesizer, else the first of the
 * system's voice programs that is installed. False when none could speak.
 */
async function speakWithSystem($: EngineInterface, text: string, run: Run): Promise<boolean> {
  const abort = new AbortController()
  run.stop = () => {
    run.isStopped = true
    abort.abort()
  }
  try {
    await $.audio.speak(text, { signal: abort.signal })
    return true
  } catch {
    if (run.isStopped) return true
  }
  const platform = await platformOf($)
  for (const voice of systemVoices(platform)) {
    if (run.isStopped) return true
    const ended = await speakWithProgram($, platform, voice, text, run)
    note(`system voice ${voice.name}: ${ended}`)
    if (ended === 'spoke') return true
  }
  return false
}

/** Reads `text` with one voice program; 'missing' when it is not installed. */
async function speakWithProgram(
  $: EngineInterface,
  platform: Platform,
  voice: SystemVoice,
  text: string,
  run: Run,
): Promise<'spoke' | 'missing' | 'failed'> {
  let pid: string | undefined
  const kill = () => {
    if (pid !== undefined) void $.process.run(stopCommand(platform, pid, false)).catch(() => undefined)
    if (voice.cancel !== undefined) void $.process.run(voice.cancel).catch(() => undefined)
  }
  run.stop = () => {
    run.isStopped = true
    kill()
  }
  try {
    const child = $.process.spawn({
      argv: voice.argv,
      ...(voice.textVia === 'env' ? { env: { [TEXT_VAR]: text } } : { input: text }),
    })
    let pending = ''
    for await (const { stream, text: piece } of child) {
      if (stream !== 'stdout' || pid !== undefined) continue
      pending += piece
      const first = /^pid (\d+)\r?\n/.exec(pending)
      if (first !== null) {
        pid = first[1]
        if (run.isStopped) kill()
      }
    }
    const ended = await child.result
    if (run.isStopped || ended.code === 0) return 'spoke'
    return ended.code === NOT_FOUND ? 'missing' : 'failed'
  } catch {
    return run.isStopped ? 'spoke' : 'missing'
  }
}

async function stopSpeaking($: EngineInterface): Promise<void> {
  current?.stop()
  current = undefined
  await update($, reading, () => null)
  await update($, target, () => null)
}

let isSettingUp = false
/** Whether this session has said once that `/speak setup` gives the natural voice. */
let hasHintedSetup = false

/** The first Python 3 that runs, as an argument list, or undefined. */
async function findSetupPython($: EngineInterface, platform: Platform): Promise<string[] | undefined> {
  for (const python of setupPythons(platform)) {
    try {
      const ran = await $.process.run([...python, '-c', 'import sys; print(sys.version_info[0])'])
      if (ran.exitCode === 0 && ran.stdout.trim() === '3') return python
    } catch {
      // not installed: try the next
    }
  }
  return undefined
}

/**
 * `/speak setup`: runs the mod's own tts/setup_voice.py, which installs the
 * Kokoro voice, in the background. Its `step` lines go to the status line, and
 * a toast says how it ended.
 */
async function startSetup($: EngineInterface): Promise<string> {
  if (isSettingUp) return 'The voice setup is already running; the status line shows its step.'
  if ((await findKokoro($)) !== undefined) return 'The natural voice is already installed.'
  const root = (await $.process.hookEnv()).CLAUDE_PLUGIN_ROOT
  if (!root) return 'Could not find the mod’s folder, so the voice setup cannot run.'
  const platform = await platformOf($)
  const home = (await homesHere($, platform))[0]
  if (home === undefined) return 'Could not find a folder to install the voice in (no home folder is set).'
  const python = await findSetupPython($, platform)
  if (python === undefined) {
    return 'Python 3 was not found. Install Python 3.12 from https://www.python.org/downloads/ and run /speak setup again.'
  }
  isSettingUp = true
  void (async () => {
    let failed: string | undefined
    try {
      const child = $.process.spawn({
        argv: [...python, '-I', joinPath(platform, root, 'tts', 'setup_voice.py'), '--install-dir', home],
      })
      let pending = ''
      for await (const { stream, text } of child) {
        if (stream !== 'stdout') continue
        pending += text
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const [kind = '', ...rest] = line.trim().split(' ')
          if (kind === 'step') $.ui.status(`🔊 Voice setup ${rest.join(' ')}…`)
          else if (kind === 'error') failed = rest.join(' ')
        }
      }
      const ended = await child.result
      if (ended.code !== 0 && failed === undefined) failed = `the script ended with code ${ended.code}`
    } catch (error) {
      failed = String(error)
    } finally {
      isSettingUp = false
      $.ui.status(undefined)
    }
    note(failed === undefined ? 'setup: done' : `setup: failed: ${failed}`)
    await flushNotes($)
    const said = failed === undefined ? 'The natural voice is ready. Select text and read it aloud.' : `Voice setup failed: ${failed}`
    await Promise.resolve($.ui.toast(said)).catch(() => undefined)
  })()
  return 'Setting up the natural voice: a Python environment and a 340 MB voice model. It takes a few minutes; the status line shows each step.'
}

/**
 * How to start a reading where the session is drawn: the right-click row is
 * the desktop app's alone, and a surface may report no selection at all.
 */
async function howToRead($: EngineInterface, isFullscreen: boolean): Promise<string> {
  const surfaces = await $.session.surfaces()
  const last = 'Or type /speak last to hear Claude’s latest reply.'
  if (surfaces.includes('desktop')) return `Select text in a reply, then right-click → 🔊 Read aloud (or type /speak). ${last}`
  const how = 'Select text in a reply with the mouse, then type /speak.'
  if (surfaces.includes('terminal') && !isFullscreen) {
    return `${how} (The terminal reports a selection only in its fullscreen layout.) ${last}`
  }
  return `${how} ${last}`
}

/** The newest reply block drawn, which /speak last reads; an older row redrawn does not count. */
let lastReply: { rowId: string; text: string } | undefined
const seenReplies = new Set<string>()

function rememberReply(rowId: string, text: string): void {
  if (lastReply?.rowId !== rowId && seenReplies.has(rowId)) return
  seenReplies.add(rowId)
  lastReply = { rowId, text }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'speak',
      description:
        'Read aloud: /speak reads your selected text, /speak last the latest reply, /speak stop stops, ' +
        '/speak voice picks the voice, /speak mark how the word is marked, /speak setup installs the natural voice',
      argumentHint: '[last | stop | setup | voice <name> | mark orange|color|code|bold]',
    })
    // The "Speak reply" pane of earlier versions: close it if it is still open.
    void $.ui.close({ id: OLD_PANE }).catch(() => undefined)
    return next(e)
  })

  // Right-click on selected text: a "Read aloud" row in the menu.
  on('ui.render', { component: 'ContextMenu' }, async ($, e, next) => {
    const selected = e.props.selection?.text
    if (selected === undefined || selected.trim() === '') return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const isReading = (await read($, reading)) !== null
    // The desktop names the row the menu opened on; marking works in these kinds of row.
    const markable = ['AssistantMessage', 'CommandOutput', 'UserMessage']
    const row = e.props.row !== undefined && markable.includes(e.props.row.component) ? e.props.row.requestId : undefined
    const rowId = e.props.selection?.requestId ?? row
    note(
      `menu: ${selected.length} chars selected, selection row=${e.props.selection?.requestId ?? '-'}, ` +
        `opened on ${e.props.row ? `${e.props.row.component} ${e.props.row.requestId}` : '-'}`,
    )
    return (
      <Box flexDirection="column">
        <Button key="read-selection" onPress={() => speakSelection($, selected, rowId)}>
          🔊 Read aloud
        </Button>
        {isReading && (
          <Button key="stop-reading" onPress={() => stopSpeaking($)}>
            ■ Stop reading
          </Button>
        )}
      </Box>
    )
  })

  // The spoken word marked on the text already there, in Claude's replies, a
  // command's output and the person's own messages. Only the drawing changes;
  // the stored messages stay as they were.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary !== true) rememberReply(e.requestId, e.props.text)
    const d = await decide($, e.requestId, e.props.text, true, e.props.isSummary === true)
    if (d.kind === 'pass') return next(e)
    if (d.kind === 'rewrite') return next({ ...e, props: { ...e.props, text: d.text } })
    const { Box, Markdown, Text } = $.ui.resolve(e)
    return drawParts({ Box, Markdown, Text }, d)
  })
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const d = await decide($, e.requestId, e.props.text, true, false)
    if (d.kind === 'pass') return next(e)
    if (d.kind === 'rewrite') return next({ ...e, props: { ...e.props, text: d.text } })
    const { Box, Markdown, Text } = $.ui.resolve(e)
    return drawParts({ Box, Markdown, Text }, d)
  })
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const d = await decide($, e.requestId, e.props.text, false, false)
    if (d.kind !== 'draw') return next(e)
    const { Box, Markdown, Text } = $.ui.resolve(e)
    return drawParts({ Box, Markdown, Text }, d)
  })

  // ── The band above the prompt: OFF while the in-chat marking is tried. ──
  // To bring it back, delete the `/*` line below and the `*/` line after it;
  // `reading` is still kept up to date for it, and its test is kept likewise.
  //
  // While reading: one row above the prompt, the words around the spoken one,
  // that word lit, the ones already read plain, the ones to come dim.
  /*
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, reading)
    if (view === null || e.props.hasSurvey || e.props.isCollapsed) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const stop = <Button key="stop" plain label="■" onPress={() => stopSpeaking($)} />

    if (view.voice === 'windows' || view.current < 0) {
      const note = view.voice === 'windows' ? 'Reading with the system voice (no word tracking)…' : 'Starting the voice…'
      return (
        <Box flexDirection="row" gap={1}>
          {stop}
          <Text dimColor wrap="truncate-end">{note}</Text>
        </Box>
      )
    }

    // The stop mark and its gap take 2 columns, the ellipses at each end 2 more.
    const { start, end } = windowAround(view.words, view.current, Math.max(10, e.props.bodyColumns - 6))
    const spans = []
    if (start > 0) spans.push(<Text dimColor>… </Text>)
    for (let i = start; i <= end; i++) {
      const gap = i < end ? ' ' : ''
      spans.push(
        i === view.current ? (
          <Text>
            <Text bold inverse>{view.words[i]!}</Text>
            {gap}
          </Text>
        ) : (
          <Text dimColor={i > view.current}>{view.words[i]! + gap}</Text>
        ),
      )
    }
    if (end < view.words.length - 1) spans.push(<Text dimColor> …</Text>)
    return (
      <Box flexDirection="row" gap={1}>
        {stop}
        <Text wrap="truncate-end">{spans}</Text>
      </Box>
    )
  })
  */

  on('command.run', { command: 'speak' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') {
      await stopSpeaking($)
      return { text: 'Stopped.' }
    }
    if (arg === 'mark' || arg.startsWith('mark ')) {
      const wanted = arg.slice('mark'.length).trim()
      if (wanted === '') {
        return { text: `Spoken words are marked as ${await chosenMark($)}. Switch with /speak mark orange (bold orange), color (orange, the line never moves), code or bold.` }
      }
      if (!(MARK_STYLES as readonly string[]).includes(wanted)) {
        return { text: `"${wanted}" is not a mark style. Use /speak mark orange, color, code or bold.` }
      }
      await $.store.set(MARK_KEY, wanted)
      return { text: `Spoken words will be marked as ${wanted} from the next reading.` }
    }
    if (arg === 'voice' || arg.startsWith('voice ')) {
      const wanted = arg.slice('voice'.length).trim()
      if (wanted === '') {
        const now = await chosenVoice($)
        return {
          text: `Voice: ${now}. Others: ${VOICES.filter(v => v !== now).join(', ')}. ` +
            '(af/am = American woman/man, bf/bm = British.) Change it with /speak voice <name>.',
        }
      }
      if (!(VOICES as readonly string[]).includes(wanted)) {
        return { text: `"${wanted}" is not one of the voices. Type /speak voice to list them.` }
      }
      await $.store.set('voice', wanted)
      return { text: `Voice set to ${wanted}.` }
    }
    if (arg === 'setup') return { text: await startSetup($) }
    if (arg === 'last') {
      if (lastReply === undefined) return { text: 'There is no reply to read yet.' }
      return { text: await speakSelection($, lastReply.text, lastReply.rowId, 'the latest reply') }
    }
    if (arg === '') {
      const selected = await $.ui.selection()
      if (selected !== undefined && selected.text.trim() !== '') {
        return { text: await speakSelection($, selected.text, selected.requestId) }
      }
      return { text: `Nothing selected. ${await howToRead($, e.presentation?.isFullscreen === true)}` }
    }
    return {
      text: `Unknown option "${e.args.trim()}". Use /speak, /speak last, /speak stop, /speak setup, /speak voice <name> or /speak mark orange|color|code|bold.`,
    }
  })
}
