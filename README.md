# Paragraph Speaker

**Read any part of a Claude Code reply aloud, in a natural voice, with each word marked as it is spoken.**

Long answers are easier to take in when you can listen and follow along. Select a paragraph, a list or a table, and the mod reads it to you while the word being spoken is marked in the reply itself, so your eyes follow your ears. Tables are explained in plain words instead of being read cell by cell, and the cells being talked about are marked as it goes.

The voice ([Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)) runs on your own computer.

<!-- Demo video: add the link here -->

## Install

**1. Add the mod.** In Claude Code in a terminal, type:

```
/plugin install paragraph-speaker --marketplace nidnawatha-L26/paragraph-speaker
```

Answer `y` to add the marketplace, then choose the **user** scope so the mod is on in all your sessions.

**2. Install the natural voice (once).** Type:

```
/speak setup
```

It takes about 1 minute plus the time to download about 380 MB, so usually 2 to 6 minutes. The status line shows each step. It:

- checks the disk has **1 GB free** first, and stops with a message if not: the voice uses about **500 MB**, and the rest keeps your disk from running full,
- finds Python 3.10 to 3.13 on your computer (3.12 recommended, from [python.org](https://www.python.org/downloads/)),
- creates a separate Python environment in the folder below, so nothing is added to your system Python,
- installs [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) 0.6.1 there,
- downloads the voice model, about 340 MB, from the kokoro-onnx releases and checks each file's SHA-256 before using it.

| System | Where the voice is installed |
|---|---|
| Windows | `%LOCALAPPDATA%\paragraph-speaker` |
| macOS | `~/Library/Application Support/paragraph-speaker` |
| Linux | `$XDG_DATA_HOME/paragraph-speaker`, or `~/.local/share/paragraph-speaker` |

If the setup fails, it deletes what it made, so nothing is left taking up space. You can also run the same script by hand from the mod's folder: `python3 -I tts/setup_voice.py` (on Windows `py -3 -I tts\setup_voice.py`). It uses only Python's standard library.

Until the voice is installed, the mod reads with the system's own voice, which works but cannot mark each word.

### What each system needs

| System | Natural voice (Kokoro) | Without it |
|---|---|---|
| Windows 10 or 11 | Python 3.10 to 3.13 | The Windows voice (System.Speech) |
| macOS | Python 3.10 to 3.13 (python.org or Homebrew); sound plays with `afplay` | `say` |
| Linux | Python 3.10 to 3.13 with `venv` (on Debian or Ubuntu: `python3-venv`); one of `pw-play` (PipeWire), `paplay` (PulseAudio) or `aplay` (ALSA) | `espeak-ng`, `espeak` or `spd-say` (speech-dispatcher), the first one installed |

The text you listen to reaches the voice through standard input or an environment variable, never through a command line.

## Update

Claude Code doesn't update this mod by itself. It keeps plugins up to date automatically only from Anthropic's official marketplaces; for other marketplaces, like this one, automatic updates start switched off. To get the latest version:

**1. Update the mod.** Type `/plugin`, open the **Installed** tab, choose **paragraph-speaker**, and pick **Update now**. Or, in a terminal:

```
claude plugin update paragraph-speaker@paragraph-speaker
```

**2. Load it.** Type `/reload-plugins`, or restart Claude Code.

The voice you installed with `/speak setup` stays where it is, so there is no need to run the setup again.

**To get updates without asking**, type `/plugin`, open the **Marketplaces** tab, choose **paragraph-speaker**, and switch on auto-update. Claude Code then looks for a new version each time it starts, and the new version loads the next time you start it (or after `/reload-plugins`).

## Use

| Where | How |
|---|---|
| Claude desktop app (Code tab) | Select text in a reply, right-click, and choose **🔊 Read aloud** |
| Terminal | Select text with the mouse, then type `/speak` (the selection needs the terminal's fullscreen layout) |
| VS Code extension | Select text and type `/speak`; where no selection is reported, `/speak last` reads the latest reply |

| Command | What it does |
|---|---|
| `/speak` | Reads the text you selected |
| `/speak last` | Reads Claude's latest reply |
| `/speak stop` | Stops reading |
| `/speak voice` | Lists the voices; `/speak voice bm_george` picks one |
| `/speak mark orange` | How the spoken word is marked: `orange` (default), `color`, `code` or `bold` |
| `/speak setup` | Installs the natural voice |

## Speed and memory

The first reading in a session takes a few seconds while the voice loads. The voice then stays loaded, so later readings start in about a second, and it starts with the first few words instead of waiting for the whole first sentence. While loaded it uses about **600 MB of memory**, and it closes by itself after **10 minutes** without a reading. If it cannot be loaded, each reading starts the voice on its own, as before.

## Where it works

- **Windows, macOS and Linux.** The mod asks Claude Code which system it runs on, and picks the install folder, the sound player, the way to stop and the fallback voice for it. Under WSL it acts as on Linux.
- **The desktop app's Code tab** has everything, including the right-click menu.
- **In the terminal**, select text with the mouse and type `/speak`. The right-click menu is only in the desktop app.
- **In the VS Code extension**, the spoken word is marked in the reply as elsewhere. The right-click row is the desktop app's alone, so use `/speak` or `/speak last`.
- **Status line and toasts**: the setup's steps show in the status line and how it ended in a toast. Where a surface draws neither, the command's own reply still says what happens.
- There is no speaker button in a reply's copy and bookmark row: Claude Code does not let a mod add to that row.

Tested with Claude Code 2.1.331: the scripts on Windows 10, macOS 26 and Ubuntu (Linux). The voice that stays loaded (1.2.0) is tested with real speech on Windows 11; on macOS and Linux its tests stand in for the system.

## Privacy

Speech is made on your computer, and the text you listen to is not sent anywhere to be spoken. The loaded voice listens only on your computer: a private named pipe on Windows, and a socket in a folder only you can open on macOS and Linux, protected by a random key made each time it starts. Nothing is opened to the network. When your selection holds a table, the table is sent to Claude Haiku through your own Claude Code session to explain it, as any prompt is.

## Remove

Uninstall it from `/plugin`. To remove the voice too, close Claude Code (so the loaded voice is not running), then delete its folder (see the table under Install). On Windows, if the setup ran from the desktop app, it may be under `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\paragraph-speaker` instead.

## Development

Run the mod's tests with `claude plugin test .` and the scripts' tests with `python3 -m unittest discover -s tts`.

## Credits

The voice is [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad, run with [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) by thewh1teagle.

## License

MIT. See [LICENSE](LICENSE).
