# html-editor

*[Leer en castellano](README.es.md)*

A visual editor for the HTML files sitting in your folder. One Go binary, no
runtime, no project setup, no database: you run it, your browser opens, you edit
the page as a document, you press Save, and the file on disk changes.

```bash
cd myfolder
html-editor mypage.html      # opens the browser on that file
```

Close the tab and the command exits a few seconds later, like any other
well-behaved desktop tool.

## Why

Editing a small static page usually means either hand-writing HTML or dragging a
whole site builder into the picture. `html-editor` sits in between: it edits
**the file you already have**, in place, keeping its structure, its stylesheet
and its images exactly where they are. The folder stays publishable as-is.

## Install

Requires Go 1.21 or newer.

```bash
git clone https://github.com/neitanod/html-editor.git
cd html-editor
make install          # builds and links the binary into ~/bin
```

`make install` creates a symlink, so a later `make build` updates the installed
command too. Use `PREFIX=/usr/local/bin sudo make install` for a system-wide
link, or just `make build` and put the binary wherever you like.

## Usage

```
html-editor [OPTIONS] [FILE]
```

| | |
|---|---|
| `html-editor` | edits `index.html` in the current folder |
| `html-editor about.html` | edits that file |
| `html-editor docs/guide.html` | edits a file in another folder |

If the file does not exist it is created with a complete skeleton: `<!DOCTYPE
html>`, `<html lang>`, a `<head>` with charset, viewport and title, and a
readable default stylesheet.

### Options

| Flag | Meaning |
|---|---|
| `--port <n>` | Port for the local server (default: first free port from 8477) |
| `--host <addr>` | Bind address (default `127.0.0.1`, `0.0.0.0` with `--serve`) |
| `--serve` | Server mode: no browser, no auto-exit — good for a systemd unit |
| `--read-only` | Every write endpoint is disabled |
| `--no-browser` | Start normally but do not open the browser |
| `--dev <dir>` | Serve the UI from a source folder instead of the embedded copy |
| `--version` | Print version information |

## What it does

**WYSIWYG that is really the page.** The document is served from its own folder
and rendered in an iframe, so its stylesheet, its fonts and its relative images
look exactly like they will when the file is opened directly. Scripts in the
document are parked while editing and restored untouched on save.

**Split source view.** Press *Source* (or `Ctrl+Shift+E`) to see the generated
HTML next to the page, syntax-highlighted and editable. Apply pushes your edits
back into the visual side; the visual side keeps the source in sync as you type.

**Pasted images are stored, not embedded.** Paste or drop an image and it is
written next to the document with a unique name and referenced relatively
(`<img src="photo.png">`) — never as a multi-megabyte data URL. Drag the handles
to resize it: the aspect ratio is preserved unless you hold *Shift*.

**Links you can actually edit.** Click a link and a panel appears above or below
it — whichever fits — with the readable text, the address, a "new tab" toggle, a
*Remove link* button and an *Open* button that follows it in another tab.

**Right-click anything.** Copy, cut, duplicate, delete, wrap in a container,
select the parent, copy the HTML, jump to the element in the source view, and
open its properties. Right-clicking the background gives you the same for
`<body>`, plus the `<head>` metadata and the `<html>` element.

**Properties without knowing HTML.** The inspector edits fonts, sizes, colours,
alignment, borders, padding, margins, backgrounds, size, position and effects
with real form controls, alongside a raw attribute table for when you do know
what you are doing. Document settings cover the title, charset, viewport,
description, author, favicon and Open Graph tags.

**Tables like a word processor.** Insert with a hover grid, then add or delete
rows and columns, merge and split cells, toggle the header row, resize columns
by dragging and move between cells with Tab.

**Bilingual interface.** English and Spanish, switchable from the top right.

### Keyboard

| | |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+B` `Ctrl+I` `Ctrl+U` | Bold, italic, underline |
| `Ctrl+K` | Insert or edit a link |
| `Ctrl+Shift+E` | Toggle the source view |
| `Ctrl+Shift+V` | Paste as plain text |
| `Ctrl+Enter` | Apply the source view to the document |

## Safety

The first save of a session copies the file it found on disk to `<file>.bak`.
Saves are atomic: the new content goes to a temporary file in the same folder
and is renamed over the original, so an interrupted save never truncates your
document. The server only ever reads and writes inside the folder of the file
you opened, and binds to `127.0.0.1` unless you ask otherwise.

## Development

```
main.go        CLI flags, document resolution, server start-up
server.go      SSE client tracking, auto-shutdown, port probing, asset naming
app.go         HTTP routes: shell, /doc/, /api/document, /api/assets, /api/stream
document.go    file creation, atomic save, script parking
templates/     the editor shell (embedded)
static/        css and js modules (embedded)
```

Everything is Go standard library and dependency-free vanilla JavaScript; there
is no build step for the frontend. `make build` produces the single binary.

## License

MIT — see [LICENSE](LICENSE).
