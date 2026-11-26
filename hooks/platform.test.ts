import { expect, test } from 'claude-code/testing'

import { TEXT_VAR, installHomes, joinPath, setupPythons, stopCommand, systemVoices, venvPython } from './register'

test('paths join with the system separator, extra separators dropped', () => {
  expect(joinPath('windows', 'C:\\Users\\u\\', 'a', 'b.txt')).toBe('C:\\Users\\u\\a\\b.txt')
  expect(joinPath('macos', '/Users/u/', '/a/', 'b.txt')).toBe('/Users/u/a/b.txt')
  expect(joinPath('linux', '/', 'home', 'u')).toBe('/home/u')
})

test('the voice is installed in each system’s own place for app data', () => {
  expect(installHomes('windows', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toEqual([
    'C:\\Users\\u\\AppData\\Local\\paragraph-speaker',
    'C:\\Users\\u\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\paragraph-speaker',
  ])
  expect(installHomes('macos', { HOME: '/Users/u' })).toEqual(['/Users/u/Library/Application Support/paragraph-speaker'])
  expect(installHomes('linux', { HOME: '/home/u' })).toEqual(['/home/u/.local/share/paragraph-speaker'])
  expect(installHomes('linux', { HOME: '/home/u', XDG_DATA_HOME: '/data/u' })).toEqual(['/data/u/paragraph-speaker'])
  // XDG: a relative XDG_DATA_HOME is ignored
  expect(installHomes('linux', { HOME: '/home/u', XDG_DATA_HOME: 'rel' })).toEqual(['/home/u/.local/share/paragraph-speaker'])
  expect(installHomes('windows', {})).toEqual([])
  expect(installHomes('macos', {})).toEqual([])
})

test('the voice’s Python sits where venv puts it on each system', () => {
  expect(venvPython('windows', 'C:\\h')).toBe('C:\\h\\venv\\Scripts\\python.exe')
  expect(venvPython('macos', '/h')).toBe('/h/venv/bin/python')
  expect(venvPython('linux', '/h')).toBe('/h/venv/bin/python')
})

test('stop uses taskkill on Windows and kill elsewhere, the whole group for Kokoro', () => {
  expect(stopCommand('windows', '42', true)).toEqual(['taskkill', '/F', '/T', '/PID', '42'])
  expect(stopCommand('macos', '42', true)).toEqual(['kill', '-TERM', '--', '-42'])
  expect(stopCommand('linux', '42', false)).toEqual(['kill', '-TERM', '42'])
})

test('each system has its own fallback voice, and the text is never on a command line', () => {
  expect(systemVoices('windows').map(v => v.name)).toEqual(['Windows voice'])
  expect(systemVoices('macos').map(v => v.name)).toEqual(['say'])
  expect(systemVoices('linux').map(v => v.name)).toEqual(['espeak-ng', 'espeak', 'spd-say'])
  const windows = systemVoices('windows')[0]!
  expect(windows.textVia).toBe('env')
  expect(windows.argv.at(-1)).toContain(`$env:${TEXT_VAR}`)
  for (const platform of ['macos', 'linux'] as const) {
    for (const voice of systemVoices(platform)) {
      expect(voice.textVia).toBe('stdin')
      expect(voice.argv.slice(0, 2)).toEqual(['sh', '-c'])
    }
  }
  expect(systemVoices('linux').find(v => v.name === 'spd-say')?.cancel).toEqual(['spd-say', '--cancel'])
})

test('setup runs with the Python launcher on Windows and python3 elsewhere', () => {
  expect(setupPythons('windows')[0]).toEqual(['py', '-3'])
  expect(setupPythons('macos')[0]).toEqual(['python3'])
  expect(setupPythons('linux')[0]).toEqual(['python3'])
})
