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
    html-editor [OPTIONS] [FILE]

FILE:
    Path of the .html file to edit. Defaults to %s in the current
    directory. If the file does not exist it is created with a complete
    HTML skeleton (html, head with title/charset/viewport, and body).

OPTIONS:
    --port <n>        Port for the local server (0 = pick a free one)
    --host <addr>     Bind address (default 127.0.0.1, or 0.0.0.0 with --serve)
    --serve           Server mode: do not open the browser, never auto-exit
    --read-only       Disable every write endpoint (view only)
    --no-browser      Start normally but do not open the browser
    --dev <dir>       Serve the UI from a source folder (development)
    --version         Print version information
    --help            Show this help

EXAMPLES:
    html-editor                     # edit ./index.html
    html-editor about.html          # edit ./about.html
    html-editor docs/guide.html     # edit a file in another folder
    html-editor --serve --port 8099 # run as a daemon, no browser

Pasted images are stored next to the document and linked relatively, so the
folder stays self-contained and can be published as-is.
`, defaultFileName)
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

	doc, err := OpenDocument(target)
	if err != nil {
		log.Fatalf("html-editor: %v", err)
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
	fmt.Printf("editing  %s\n", doc.Path)
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
