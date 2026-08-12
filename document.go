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
}

// OpenDocument resolves target, creating the file with a full HTML skeleton
// when it does not exist yet.
func OpenDocument(target string) (*Document, error) {
	abs, err := filepath.Abs(target)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve %q: %w", target, err)
	}

	info, err := os.Stat(abs)
	switch {
	case err == nil && info.IsDir():
		abs = filepath.Join(abs, defaultFileName)
		info, err = os.Stat(abs)
		if err == nil && info.IsDir() {
			return nil, fmt.Errorf("%s is a directory", abs)
		}
	case err == nil:
		// Existing file, nothing to do.
	}

	if _, err := os.Stat(abs); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return nil, fmt.Errorf("cannot create folder for %s: %w", abs, err)
		}
		title := titleFromFileName(filepath.Base(abs))
		if err := os.WriteFile(abs, []byte(skeleton(title)), 0o644); err != nil {
			return nil, fmt.Errorf("cannot create %s: %w", abs, err)
		}
		fmt.Printf("created  %s\n", abs)
	} else if err != nil {
		return nil, err
	}

	return &Document{
		Path: abs,
		Dir:  filepath.Dir(abs),
		Name: filepath.Base(abs),
	}, nil
}

// Read returns the current content of the file on disk.
func (d *Document) Read() (string, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	data, err := os.ReadFile(d.Path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Write saves content atomically (temp file + rename) and keeps a single
// ".bak" copy of the version that was on disk before the first save.
func (d *Document) Write(content string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

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
	return nil
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
