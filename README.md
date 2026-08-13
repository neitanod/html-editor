# html-editor

*[Leer en castellano](README.es.md)*

A visual editor for the HTML files sitting in your folder. One Go binary, no
runtime, no project setup, no database: you run it, your browser opens, you edit
the page as a document, and the file on disk changes on its own a couple of
seconds later.

```bash
cd myfolder
html-editor mypage.html      # opens the browser on that file
```

Close the tab and the command exits a few seconds later, like any other
well-behaved desktop tool.

![The editor with the source view open and a link being edited](docs/screenshot.png)

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
| `html-editor recipes` | edits `recipes/index.html` |
| `html-editor received.mhtml` | unpacks the archive into `received/` and edits it |

**A name with an extension is a file; a name without one is a folder**, and its
`index.html` is what gets edited. That is the shorthand for keeping a document
together with its images: everything you paste lands in that same folder, so it
can be published, zipped or moved as a unit.

A document that does not exist yet opens on a complete skeleton — `<!DOCTYPE
html>`, `<html lang>`, a `<head>` with charset, viewport and title, and a
readable default stylesheet. Nothing is written until you edit it: the folder
and the file are created by the first change, so opening a name just to look at
it and closing the tab leaves no trace. An `index.html` that is not on disk yet
takes its title from the folder name.

### Options

| Flag | Meaning |
|---|---|
| `--port <n>` | Port for the local server (default: first free port from 8477) |
| `--host <addr>` | Bind address (default `127.0.0.1`, `0.0.0.0` with `--serve`) |
| `--serve` | Server mode: no browser, no auto-exit — good for a systemd unit |
| `--read-only` | Every write endpoint is disabled |
| `--no-browser` | Start normally but do not open the browser |
| `--dev <dir>` | Serve the UI from a source folder instead of the embedded copy |
| `--export-mhtml` | Pack the document into an `.mhtml` file and exit |
| `--version` | Print version information |

## What it does

**WYSIWYG that is really the page.** The document is served from its own folder
and rendered in an iframe, so its stylesheet, its fonts and its relative images
look exactly like they will when the file is opened directly. Scripts in the
document are parked while editing and restored untouched on save.

**Autosave.** Two seconds after you stop changing something, the document is
written to disk — and, if you never stop, it is written anyway every ten
seconds. It happens quietly: the status bar and the dot next to the file name
are the only sign, and a toast shows up only if a write fails. `Ctrl+S` and the
*Save* button still work and still confirm; they are there for when you want to
be sure, not because anything depends on them. Leaving the tab, hiding it or
closing it writes what was still pending. `--read-only` disables all of it.

**Split source view.** Press *Source* (or `Ctrl+Shift+E`) to see the generated
HTML next to the page, syntax-highlighted and editable. Apply pushes your edits
back into the visual side; the visual side keeps the source in sync as you type.

**Pasted images are stored, not embedded.** Paste or drop an image and it is
written next to the document with a unique name and referenced relatively
(`<img src="photo.png">`) — never as a multi-megabyte data URL. Drag the handles
to resize it: the aspect ratio is preserved unless you hold *Shift*.

**Crop, rotate and straighten.** Select a picture and the bar above it turns it
a quarter turn either way; *Crop and rotate* opens a dialog with a frame you
drag over the photograph, fixed proportions (1:1, 4:3, 3:4, 16:9 or the
original), horizontal and vertical mirroring, and a slider that straightens a
crooked horizon, shrinking the frame on its own so the empty corners a turn
leaves behind stay out of it. The result is written as a new file beside the
document and the `<img>` points at it: the markup stays as plain as it was — no
wrapper, no `transform` — and the original file is kept in the folder, so Ctrl+Z
gives you back the picture you had. An SVG is left alone, because turning
shapes into pixels to crop them is a downgrade dressed as an edit; and a picture
that still lives on another site is offered the download that brings it into the
folder first.

**Double-click a picture to see it large.** It fills the screen, where the wheel
zooms towards the pointer, dragging walks around what no longer fits and a
double click swings between fitting and life size. The document is read as a
gallery from there: the arrows on the sides, and the left and right keys, step
through every other picture in the order they appear in the page, with Escape
closing on the one you were looking at, already selected.

**Content pasted from the web can bring its images along.** When what you paste
links images hosted on another site, the editor asks whether to paste it as is
or to download those resources: they are stored next to the document and
relinked relatively, so the folder does not depend on a site you do not control.
It covers `src`, `srcset`, `poster` and the `url()` of inline styles, and the
same command is available for the whole document from the background
context menu (*Download external resources*). A resource that cannot be
downloaded keeps its original address instead of breaking the rest.

**One file to send: `.mhtml`.** A folder is the right shape to work in and the
wrong shape to mail. *Export to .mhtml* packs the document with its images and
stylesheets into a single file — the "web page, single file" of Chrome, Edge and
Word — and *Import an .mhtml* unpacks one back into the folder, so what you
received is editable with everything else here. It is a mail message (RFC 2557),
not a zip: plain text you can read with a pager, with the binaries in base64.
Addresses that point at other sites stay remote, and nothing in the archive
reveals where the folder lives on your disk.

From the shell it works without opening the editor:

```
html-editor --export-mhtml recipes   # writes recipes/index.mhtml
html-editor received.mhtml           # unpacks it into ./received/ and opens it
```

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

**Notes, quotations and code blocks.** Select some text, press the button and it
lands in a box with a look of its own: a note beside the text, a quotation with
its source line, or a code block in monospace on a dark background. The look of
each kind travels inside the document, in a tag of its own with a fixed id —
`html-editor-notes-styles`, `html-editor-citation-styles` and
`html-editor-sourcecode-styles` — written the first time you use that block and
never touched again: whatever you tweak in there stays yours, and every later
block of the same kind follows it. Pressing the same button from inside a box
takes it off and gives the content back to the document.

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

The first save of a session copies the file it found on disk to `<file>.bak`,
which is what autosave writes over from then on: the backup stays at the version
you opened, however many times the document is written afterwards.
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
