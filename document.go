package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Document is the HTML file being edited plus the folder that owns it. Every
// relative asset (images, stylesheets) lives in Dir, which is also the root the
// preview is served from so relative URLs behave exactly like on disk.
type Document struct {
	mu   sync.RWMutex
	Path string // absolute path of the file
	Dir  string // absolute path of the containing folder
	Name string // file name, e.g. "index.html"

	// pending marks a document that does not exist on disk yet. Nothing is
	// written until the first save, so opening a name to look at the skeleton
	// and closing the tab leaves no folder and no file behind.
	pending bool
}

// OpenDocument resolves target into the file to edit.
//
//	html-editor page.html    edits ./page.html
//	html-editor notes        edits ./notes/index.html, assets included
//	html-editor notes/       same, explicitly
//
// An argument with no extension names a folder: keeping a document together
// with its images in its own folder is the point of the shorthand. Neither the
// folder nor the file is created here; that happens on the first save.
func OpenDocument(target string) (*Document, error) {
	abs, err := filepath.Abs(target)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve %q: %w", target, err)
	}

	info, err := os.Stat(abs)
	switch {
	case err == nil && info.IsDir():
		abs = filepath.Join(abs, defaultFileName)
		if inner, err := os.Stat(abs); err == nil && inner.IsDir() {
			return nil, fmt.Errorf("%s is a directory", abs)
		}
	case err == nil:
		// An existing file is edited as given, extension or not.
	case os.IsNotExist(err):
		if namesFolder(target) {
			abs = filepath.Join(abs, defaultFileName)
		}
	default:
		return nil, err
	}

	doc := &Document{
		Path: abs,
		Dir:  filepath.Dir(abs),
		Name: filepath.Base(abs),
	}
	if _, err := os.Stat(abs); os.IsNotExist(err) {
		doc.pending = true
	}
	return doc, nil
}

// namesFolder reports whether an argument that does not exist yet should be
// read as a folder to create rather than as a file.
func namesFolder(target string) bool {
	trimmed := strings.TrimSpace(target)
	if strings.HasSuffix(trimmed, "/") || strings.HasSuffix(trimmed, string(os.PathSeparator)) {
		return true
	}
	return filepath.Ext(trimmed) == ""
}

// Pending reports whether the document still has to be created on disk.
func (d *Document) Pending() bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.pending
}

// Read returns the current content of the file, or the skeleton a document that
// does not exist yet will be created with.
func (d *Document) Read() (string, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	data, err := os.ReadFile(d.Path)
	if err != nil {
		if os.IsNotExist(err) && d.pending {
			return skeleton(d.defaultTitleLocked()), nil
		}
		return "", err
	}
	return string(data), nil
}

// defaultTitleLocked names an unsaved document after its folder when it is the
// index of one, which is what the folder shorthand creates.
func (d *Document) defaultTitleLocked() string {
	if d.Name == defaultFileName {
		if folder := filepath.Base(d.Dir); folder != "." && folder != string(os.PathSeparator) {
			return titleFromFileName(folder)
		}
	}
	return titleFromFileName(d.Name)
}

// Write saves content atomically (temp file + rename) and keeps a single
// ".bak" copy of the version that was on disk before the first save.
func (d *Document) Write(content string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if err := os.MkdirAll(d.Dir, 0o755); err != nil {
		return fmt.Errorf("cannot create %s: %w", d.Dir, err)
	}

	backup := d.Path + ".bak"
	if _, err := os.Stat(backup); os.IsNotExist(err) {
		if previous, err := os.ReadFile(d.Path); err == nil {
			_ = os.WriteFile(backup, previous, 0o644)
		}
	}

	tmp, err := os.CreateTemp(d.Dir, ".html-editor-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, d.Path); err != nil {
		os.Remove(tmpName)
		return err
	}
	d.pending = false
	return nil
}

// EnsureFolder creates the document folder on demand, so an asset can be stored
// before the document itself has ever been saved.
func (d *Document) EnsureFolder() error {
	d.mu.RLock()
	dir := d.Dir
	d.mu.RUnlock()
	return os.MkdirAll(dir, 0o755)
}

// ModTime reports the modification time of the file on disk.
func (d *Document) ModTime() time.Time {
	d.mu.RLock()
	defer d.mu.RUnlock()
	info, err := os.Stat(d.Path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

func titleFromFileName(name string) string {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	base = strings.NewReplacer("-", " ", "_", " ").Replace(base)
	base = strings.TrimSpace(base)
	if base == "" {
		return "Untitled"
	}
	return strings.ToUpper(base[:1]) + base[1:]
}

func skeleton(title string) string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + escapeHTMLText(title) + `</title>
<style>
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.6;
  max-width: 46rem;
  margin: 3rem auto;
  padding: 0 1.25rem;
  color: #1c1c1e;
}
</style>
</head>
<body>
<h1>` + escapeHTMLText(title) + `</h1>
<p>Start writing here.</p>
</body>
</html>
`
}

func escapeHTMLText(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// Scripts inside the edited document must not run while editing: a script that
// rewrites the DOM would corrupt what we save back. They are parked under a
// custom type when serving the preview and restored verbatim when saving.
var (
	scriptOpenRe   = regexp.MustCompile(`(?is)<script\b([^>]*)>`)
	parkedTypeAttr = `type="text/x-html-editor-parked"`
	typeAttrRe     = regexp.MustCompile(`(?is)\stype\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
)

// parkScripts disables scripts for the editing preview, remembering the
// original type attribute so unparkScripts can put it back.
func parkScripts(html string) string {
	return scriptOpenRe.ReplaceAllStringFunc(html, func(tag string) string {
		attrs := tag[len("<script") : len(tag)-1]
		original := ""
		if m := typeAttrRe.FindString(attrs); m != "" {
			original = strings.TrimSpace(m)
			attrs = typeAttrRe.ReplaceAllString(attrs, "")
		}
		parked := ` data-html-editor-parked="1"`
		if original != "" {
			parked += ` data-html-editor-type="` + strings.ReplaceAll(original, `"`, "&quot;") + `"`
		}
		return "<script " + parkedTypeAttr + parked + strings.TrimRight(attrs, " ") + ">"
	})
}

var parkedScriptRe = regexp.MustCompile(`(?is)<script\b([^>]*)>`)

// unparkScripts is the inverse of parkScripts, applied to the HTML coming back
// from the browser before it is written to disk.
func unparkScripts(html string) string {
	return parkedScriptRe.ReplaceAllStringFunc(html, func(tag string) string {
		if !strings.Contains(tag, "data-html-editor-parked") {
			return tag
		}
		attrs := tag[len("<script") : len(tag)-1]
		originalType := ""
		if m := regexp.MustCompile(`(?is)\sdata-html-editor-type\s*=\s*"([^"]*)"`).FindStringSubmatch(attrs); len(m) == 2 {
			originalType = strings.ReplaceAll(m[1], "&quot;", `"`)
		}
		attrs = regexp.MustCompile(`(?is)\sdata-html-editor-type\s*=\s*"[^"]*"`).ReplaceAllString(attrs, "")
		attrs = regexp.MustCompile(`(?is)\sdata-html-editor-parked\s*=\s*"[^"]*"`).ReplaceAllString(attrs, "")
		attrs = typeAttrRe.ReplaceAllString(attrs, "")
		if originalType != "" {
			attrs = " " + originalType + attrs
		}
		attrs = strings.TrimRight(attrs, " ")
		return "<script" + attrs + ">"
	})
}
