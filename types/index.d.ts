/**
 * What is being read aloud, as the band above the prompt shows it: the text's
 * words (split on single spaces) and the one being spoken (`current`, -1 before
 * the first). `voice` says who reads: Kokoro reports each word; a system voice
 * (`windows`, the name kept from 1.0 on every system) does not.
 */
export type ReadingView = {
  words: string[]
  current: number
  voice: 'kokoro' | 'windows'
}

/**
 * Which reply the reading's words are marked in: `rowId` names the transcript
 * row the selection lies in (absent when it spans rows: every reply row then
 * looks for the words). `id` tells one reading from the next. `style` is how
 * the spoken word is marked: bold in Claude's orange (the mod draws that
 * block), inline code (a shaded box) or bold. `skip`: ranges of word indexes
 * [from, to) that are not on screen (a table's spoken explanation), never marked.
 * `tableRefs`: while words [from, to) are spoken, the cells of the table that
 * starts at `table` (an offset in the row's markdown) they talk about.
 */
export type ReadingTarget = {
  id: number
  words: string[]
  rowId?: string
  style: 'orange' | 'color' | 'code' | 'bold'
  skip?: [number, number][]
  tableRefs?: TableRef[]
}

/**
 * One part of a table's spoken explanation: its words [from, to) and the cells
 * it is about: one cell (row and col), a row, or a column; row 0 is the header,
 * the first column is 1.
 */
export type TableRef = {
  from: number
  to: number
  table: number
  cells: { row?: number; col?: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'paragraph-speaker': {
      reading: Shaped<ReadingView | null>
      target: Shaped<ReadingTarget | null>
    }
  }
}
