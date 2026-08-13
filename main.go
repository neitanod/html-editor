// Command html-editor is a visual (WYSIWYG) editor for local .html files.
//
// It starts a small local web server, opens the browser on it and shuts itself
// down a few seconds after the last tab is closed, so it behaves like a desktop
// application launched from the shell:
//
//	cd myfolder
//	html-editor mypage.html
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Build information, injected with -ldflags at build time.
var (
	Version   = "dev"
	BuildTime = "unknown"
)

const defaultFileName = "index.html"

func printUsage() {
	fmt.Fprintf(os.Stderr, `html-editor - Visual editor for local HTML files

USAGE:
    html-editor [OPTIONS] [FILE|FOLDER]

FILE|FOLDER:
    A name with an extension is a file:   html-editor page.html
    A name without one is a folder, and
    its %s is edited:             html-editor notes
    An .mhtml archive is unpacked into
    a folder and edited:                  html-editor page.mhtml
    Nothing at all means %s in the current directory.

    A document that does not exist yet opens on a complete HTML skeleton
    (html, head with title/charset/viewport, and body); the folder and the
    file are created by the first change, so opening a name just to look at
    it and closing the tab leaves nothing behind. Pasted images are stored
    in that same folder, which keeps each document together with its assets.

    Editing writes: a couple of seconds after a change the document goes to
    disk on its own, so Ctrl+S is there to make sure, not to avoid losing
    work. --read-only disables every write.

OPTIONS:
    --port <n>        Port for the local server (0 = pick a free one)
    --host <addr>     Bind address (default 127.0.0.1, or 0.0.0.0 with --serve)
    --serve           Server mode: do not open the browser, never auto-exit
    --read-only       Disable every write endpoint (view only)
    --no-browser      Start normally but do not open the browser
    --dev <dir>       Serve the UI from a source folder (development)
    --export-mhtml    Pack the document into an .mhtml file and exit
    --version         Print version information
    --help            Show this help

EXAMPLES:
    html-editor                     # edit ./index.html
    html-editor about.html          # edit ./about.html
    html-editor docs/guide.html     # edit a file in another folder
    html-editor recipes             # edit ./recipes/index.html
    html-editor --export-mhtml recipes   # pack it into recipes/index.mhtml
    html-editor received.mhtml      # unpack it into ./received/ and edit it
    html-editor --serve --port 8099 # run as a daemon, no browser

Pasted images are stored next to the document and linked relatively, so the
folder stays self-contained and can be published as-is. That same folder can
be packed into a single .mhtml file — the "web page, single file" of Chrome,
Edge and Word — to send it by mail, and unpacked back into a folder to edit it.
`, defaultFileName, defaultFileName)
}

func main() {
	flag.Usage = printUsage

	var (
		port        = flag.Int("port", 0, "port for the local server (0 = auto)")
		host        = flag.String("host", "", "bind address")
		serve       = flag.Bool("serve", false, "server mode: no browser, no auto-exit")
		readOnly    = flag.Bool("read-only", false, "disable write endpoints")
		noBrowser   = flag.Bool("no-browser", false, "do not open the browser")
		devRoot     = flag.String("dev", "", "serve the UI from this source folder instead of the embedded copy")
		exportMHTML = flag.Bool("export-mhtml", false, "pack the document into an .mhtml file and exit")
		showVersion = flag.Bool("version", false, "print version information")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("html-editor %s (built %s)\n", Version, BuildTime)
		return
	}

	target := defaultFileName
	if flag.NArg() > 0 {
		target = flag.Arg(0)
	}

	// An .mhtml is an archive, not a document: opening one unpacks it into a
	// folder of its own and edits what came out.
	if isMHTMLName(target) {
		unpacked, err := unpackArchiveFile(target)
		if err != nil {
			log.Fatalf("html-editor: %v", err)
		}
		target = unpacked
	}

	doc, err := OpenDocument(target)
	if err != nil {
		log.Fatalf("html-editor: %v", err)
	}

	if *exportMHTML {
		path, err := exportDocument(doc)
		if err != nil {
			log.Fatalf("html-editor: %v", err)
		}
		fmt.Printf("packed   %s\n", path)
		return
	}

	bind := *host
	if bind == "" {
		if *serve {
			bind = "0.0.0.0"
		} else {
			bind = "127.0.0.1"
		}
	}

	listener, actualPort, err := listen(bind, *port)
	if err != nil {
		log.Fatalf("html-editor: cannot listen on %s: %v", bind, err)
	}

	app := NewApp(doc, &Options{
		ReadOnly: *readOnly,
		Serve:    *serve,
		Version:  Version,
		DevRoot:  *devRoot,
	})

	url := fmt.Sprintf("http://%s:%d/", displayHost(bind), actualPort)
	fmt.Printf("html-editor %s\n", Version)
	if doc.Pending() {
		fmt.Printf("new      %s (created by your first change)\n", doc.Path)
	} else {
		fmt.Printf("editing  %s\n", doc.Path)
	}
	fmt.Printf("serving  %s\n", url)
	if !*serve {
		fmt.Println("the process exits a few seconds after you close the last tab")
	}

	if !*serve && !*noBrowser {
		time.AfterFunc(150*time.Millisecond, func() { openBrowser(url) })
	}
	if !*serve {
		app.clients.ArmStartupTimeout(startupGrace)
	}

	server := &http.Server{
		Handler:           app.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := server.Serve(listener); err != nil {
		log.Fatalf("html-editor: server error: %v", err)
	}
}

// unpackArchiveFile turns page.mhtml into page/index.html plus its assets and
// answers with the document to edit. The folder it creates is a new one: an
// import that silently overwrote a folder you already had would be the kind of
// surprise a file manager never gives you.
func unpackArchiveFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	archive, err := parseMHTML(data)
	if err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}

	dir := freeFolderName(strings.TrimSuffix(path, filepath.Ext(path)))
	html, stored, err := importMHTML(archive, dir, defaultFileName)
	if err != nil {
		return "", err
	}
	document := filepath.Join(dir, defaultFileName)
	if err := os.WriteFile(document, []byte(html), 0o644); err != nil {
		return "", err
	}

	fmt.Printf("imported %s\n", absOrSelf(path))
	fmt.Printf("unpacked %s and %d file(s) next to it\n", absOrSelf(document), len(stored))
	return document, nil
}

func freeFolderName(base string) string {
	candidate := base
	for i := 2; ; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d", base, i)
	}
}

// exportDocument packs a document from the command line, so publishing a
// folder as a single file can be scripted without opening the editor.
func exportDocument(doc *Document) (string, error) {
	content, err := doc.Read()
	if err != nil {
		return "", err
	}
	data, err := buildMHTML(mhtmlDocument{
		Name:  doc.Name,
		Dir:   doc.Dir,
		HTML:  content,
		Title: titleOf(content),
		Date:  time.Now(),
	})
	if err != nil {
		return "", err
	}
	target := filepath.Join(doc.Dir, exportName(doc.Name))
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", err
	}
	return target, nil
}

func displayHost(bind string) string {
	if bind == "0.0.0.0" || bind == "" {
		return "localhost"
	}
	return bind
}

// absOrSelf returns the absolute path when it can be resolved, and the input
// unchanged otherwise, so error messages always show something usable.
func absOrSelf(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}
