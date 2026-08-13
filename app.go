package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Options carries the runtime flags the handlers care about.
type Options struct {
	ReadOnly bool
	Serve    bool
	Version  string
	// DevRoot serves the UI assets from this folder instead of the embedded
	// copy, so the interface can be edited without rebuilding the binary.
	DevRoot string
}

// App wires the document, the runtime options and the SSE client tracker that
// powers the desktop-like auto shutdown.
type App struct {
	doc     *Document
	opts    *Options
	clients *ClientTracker
}

func NewApp(doc *Document, opts *Options) *App {
	return &App{doc: doc, opts: opts, clients: NewClientTracker(opts.Serve)}
}

func (a *App) Routes() http.Handler {
	mux := http.NewServeMux()

	if a.opts.DevRoot != "" {
		mux.Handle("/static/", http.StripPrefix("/static/",
			http.FileServer(http.Dir(filepath.Join(a.opts.DevRoot, "static")))))
	} else {
		staticFS, err := fs.Sub(embeddedFS, "static")
		if err != nil {
			log.Fatalf("html-editor: cannot mount static assets: %v", err)
		}
		mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))
	}

	mux.HandleFunc("/", a.handleShell)
	mux.HandleFunc("/doc/", a.handleDocFiles)
	mux.HandleFunc("/api/stream", a.handleSSE)
	mux.HandleFunc("/api/document", a.handleDocument)
	mux.HandleFunc("/api/assets", a.handleAssets)
	mux.HandleFunc("/api/fetch-asset", a.handleFetchAsset)
	mux.HandleFunc("/api/export.mhtml", a.handleExportDownload)
	mux.HandleFunc("/api/export-mhtml", a.handleExportToFolder)
	mux.HandleFunc("/api/import-mhtml", a.handleImport)
	mux.HandleFunc("/api/folder", a.handleFolder)
	mux.HandleFunc("/api/open", a.handleOpen)
	mux.HandleFunc("/api/close", a.handleClose)

	return noCache(mux)
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		next.ServeHTTP(w, r)
	})
}

// handleShell serves the editor UI itself.
func (a *App) handleShell(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	var page []byte
	var err error
	if a.opts.DevRoot != "" {
		page, err = os.ReadFile(filepath.Join(a.opts.DevRoot, "templates", "index.html"))
	} else {
		page, err = embeddedFS.ReadFile("templates/index.html")
	}
	if err != nil {
		http.Error(w, "UI template missing", http.StatusInternalServerError)
		return
	}
	replaced := strings.NewReplacer(
		"{{VERSION}}", a.opts.Version,
		"{{FILE_NAME}}", escapeHTMLText(a.doc.Name),
		"{{FILE_PATH}}", escapeHTMLText(a.doc.Path),
		"{{READ_ONLY}}", fmt.Sprintf("%t", a.opts.ReadOnly),
	).Replace(string(page))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, replaced)
}

// handleDocFiles serves everything that lives next to the document, so the
// preview iframe resolves relative URLs exactly like a browser opening the file
// from disk. The document itself is served with its scripts parked when the
// "editor" query parameter is present.
func (a *App) handleDocFiles(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/doc/")
	if rel == "" {
		rel = a.doc.Name
	}
	target, ok := a.resolveInsideDir(rel)
	if !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	// A document that has not been saved yet is served from the skeleton it
	// will be created with, so the editor can open a name that is not on disk.
	if target == a.doc.Path && a.doc.Pending() {
		content, err := a.doc.Read()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, parkScripts(content))
		return
	}

	info, err := os.Stat(target)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if info.IsDir() {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	if target == a.doc.Path && r.URL.Query().Get("editor") != "" {
		content, err := a.doc.Read()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, parkScripts(content))
		return
	}

	if ctype := mime.TypeByExtension(filepath.Ext(target)); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	http.ServeFile(w, r, target)
}

// resolveInsideDir maps a relative URL path to a file inside the document
// folder, refusing anything that escapes it.
func (a *App) resolveInsideDir(rel string) (string, bool) {
	cleaned := path.Clean("/" + rel)
	candidate := filepath.Join(a.doc.Dir, filepath.FromSlash(strings.TrimPrefix(cleaned, "/")))
	resolved, err := filepath.Abs(candidate)
	if err != nil {
		return "", false
	}
	if resolved != a.doc.Dir && !strings.HasPrefix(resolved, a.doc.Dir+string(os.PathSeparator)) {
		return "", false
	}
	return resolved, true
}

// handleDocument returns the document metadata plus its source (GET) or saves a
// new version of it (POST).
func (a *App) handleDocument(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		content, err := a.doc.Read()
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name":     a.doc.Name,
			"path":     a.doc.Path,
			"dir":      a.doc.Dir,
			"content":  content,
			"modified": a.doc.ModTime().Format(time.RFC3339),
			"readOnly": a.opts.ReadOnly,
			"pending":  a.doc.Pending(),
			"version":  a.opts.Version,
		})
	case http.MethodPost:
		if a.opts.ReadOnly {
			writeJSONError(w, http.StatusForbidden, fmt.Errorf("read-only mode"))
			return
		}
		var payload struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<20)).Decode(&payload); err != nil {
			writeJSONError(w, http.StatusBadRequest, err)
			return
		}
		if err := a.doc.Write(unparkScripts(payload.Content)); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"saved":    true,
			"modified": a.doc.ModTime().Format(time.RFC3339),
		})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleAssets stores a pasted or dropped file next to the document and returns
// the relative name to reference it from the HTML.
//
// "overwrite" names a file that is already in the folder and asks for it to be
// replaced in place, which is what an image editor needs so that touching the
// same picture ten times leaves one file behind instead of ten.
func (a *App) handleAssets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if a.opts.ReadOnly {
		writeJSONError(w, http.StatusForbidden, fmt.Errorf("read-only mode"))
		return
	}

	var payload struct {
		Name      string `json:"name"`
		Data      string `json:"data"` // base64, without data-URL prefix
		Mime      string `json:"mime"`
		Overwrite string `json:"overwrite"` // relative name of the file to replace
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<20)).Decode(&payload); err != nil {
		writeJSONError(w, http.StatusBadRequest, err)
		return
	}

	raw, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Errorf("invalid base64 payload: %w", err))
		return
	}

	if err := a.doc.EnsureFolder(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}

	if payload.Overwrite != "" {
		name, target, err := a.replaceableAsset(payload.Overwrite, payload.Mime)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err)
			return
		}
		if err := os.WriteFile(target, raw, 0o644); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name":      name,
			"url":       "/doc/" + name,
			"size":      len(raw),
			"overwrote": true,
		})
		return
	}

	name := uniqueAssetName(a.doc.Dir, payload.Name, payload.Mime)
	if err := os.WriteFile(filepath.Join(a.doc.Dir, name), raw, 0o644); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"name": name,
		"url":  "/doc/" + name,
		"size": len(raw),
	})
}

// replaceableAsset checks that a file may be written over and answers with the
// relative name the document should keep using and the path on disk.
//
// Overwriting is the one operation here that destroys something, so it is the
// one that gets told what it may not touch: anything outside the folder, a file
// that is not there yet — that is what a new name is for — the document itself,
// and a file whose extension disagrees with what is about to be written into
// it, which would leave a .gif holding a PNG.
func (a *App) replaceableAsset(rel, mimeType string) (string, string, error) {
	// Cleaning "../foto.png" would answer with the foto.png of this folder,
	// which is a different file from the one the browser was showing. A name
	// that climbs is refused instead of quietly reinterpreted.
	if rel != path.Clean(rel) || strings.HasPrefix(rel, "/") {
		return "", "", fmt.Errorf("%s is not a plain name inside the folder", rel)
	}
	name := strings.TrimPrefix(path.Clean("/"+rel), "/")
	target, ok := a.resolveInsideDir(name)
	if !ok || name == "" {
		return "", "", fmt.Errorf("%s is not inside the document folder", rel)
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		return "", "", fmt.Errorf("%s is not a file in this folder", name)
	}
	if target == a.doc.Path {
		return "", "", fmt.Errorf("%s is the document itself", name)
	}
	want := extensionForMime(mimeType)
	if want == ".bin" {
		return "", "", fmt.Errorf("%q is not a format a picture gets written in", mimeType)
	}
	if !sameImageExtension(filepath.Ext(target), want) {
		return "", "", fmt.Errorf("%s cannot hold a %s", name, mimeType)
	}
	return name, target, nil
}

// sameImageExtension compares two extensions the way a folder does, where .jpg
// and .jpeg are the same picture format under two spellings.
func sameImageExtension(a, b string) bool {
	normalise := func(ext string) string {
		ext = strings.ToLower(ext)
		if ext == ".jpeg" {
			return ".jpg"
		}
		return ext
	}
	return normalise(a) == normalise(b)
}

// archive packs the document as it is on disk. Exporting what was saved, and
// not what the browser holds, is what keeps the archive and the folder telling
// the same story; the editor saves first when there are pending changes.
func (a *App) archive() ([]byte, string, error) {
	content, err := a.doc.Read()
	if err != nil {
		return nil, "", err
	}
	data, err := buildMHTML(mhtmlDocument{
		Name:  a.doc.Name,
		Dir:   a.doc.Dir,
		HTML:  content,
		Title: titleOf(content),
		Date:  time.Now(),
	})
	if err != nil {
		return nil, "", err
	}
	return data, exportName(a.doc.Name), nil
}

// handleExportDownload hands the archive to the browser as a download, which
// is the only way out when the editor runs on another machine (--serve).
func (a *App) handleExportDownload(w http.ResponseWriter, r *http.Request) {
	data, name, err := a.archive()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "multipart/related")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	_, _ = w.Write(data)
}

// handleExportToFolder writes the archive next to the document, which is what
// you want when the file is going to be attached to a mail right away.
func (a *App) handleExportToFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if a.opts.ReadOnly {
		writeJSONError(w, http.StatusForbidden, fmt.Errorf("read-only mode"))
		return
	}
	data, name, err := a.archive()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}
	if err := a.doc.EnsureFolder(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}
	target := filepath.Join(a.doc.Dir, name)
	if err := os.WriteFile(target, data, 0o644); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name": name,
		"path": target,
		"size": len(data),
	})
}

// handleImport unpacks an archive over the open document: the parts land in the
// document folder and the HTML replaces what was being edited. The previous
// version is kept as the usual ".bak" copy by the document writer.
func (a *App) handleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if a.opts.ReadOnly {
		writeJSONError(w, http.StatusForbidden, fmt.Errorf("read-only mode"))
		return
	}

	var payload struct {
		Data string `json:"data"` // base64, without data-URL prefix
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, mhtmlSizeLimit)).Decode(&payload); err != nil {
		writeJSONError(w, http.StatusBadRequest, err)
		return
	}
	raw, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Errorf("invalid base64 payload: %w", err))
		return
	}

	parsed, err := parseMHTML(raw)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err)
		return
	}
	if err := a.doc.EnsureFolder(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}
	html, stored, err := importMHTML(parsed, a.doc.Dir, a.doc.Name)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}
	if err := a.doc.Write(html); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"assets":   len(stored),
		"stored":   stored,
		"subject":  parsed.Subject,
		"modified": a.doc.ModTime().Format(time.RFC3339),
	})
}

// handleFolder lists the images already sitting next to the document, so the
// insert-image dialog can offer them without a file picker.
func (a *App) handleFolder(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(a.doc.Dir)
	if err != nil {
		if os.IsNotExist(err) {
			// The folder appears with the first save; until then it is empty.
			writeJSON(w, http.StatusOK, map[string]any{"dir": a.doc.Dir, "images": []any{}})
			return
		}
		writeJSONError(w, http.StatusInternalServerError, err)
		return
	}
	images := []map[string]any{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		switch ext {
		case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico":
			info, err := entry.Info()
			if err != nil {
				continue
			}
			images = append(images, map[string]any{
				"name": entry.Name(),
				"url":  "/doc/" + entry.Name(),
				"size": info.Size(),
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"dir": a.doc.Dir, "images": images})
}

func (a *App) handleOpen(w http.ResponseWriter, r *http.Request) {
	a.clients.CancelShutdown()
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleClose(w http.ResponseWriter, r *http.Request) {
	a.clients.ScheduleShutdown()
	w.WriteHeader(http.StatusNoContent)
}

// handleSSE keeps one event stream per open tab. The connection count is what
// tells the process whether anybody is still using it.
func (a *App) handleSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	a.clients.Add()
	defer a.clients.Remove()

	fmt.Fprintf(w, "event: hello\ndata: %s\n\n", jsonString(map[string]any{
		"clients": a.clients.Count(),
		"file":    a.doc.Name,
	}))
	flusher.Flush()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			fmt.Fprintf(w, "event: ping\ndata: %s\n\n", jsonString(map[string]any{
				"clients": a.clients.Count(),
			}))
			flusher.Flush()
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeJSONError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{"error": err.Error()})
}

func jsonString(payload any) string {
	data, err := json.Marshal(payload)
	if err != nil {
		return "{}"
	}
	return string(data)
}
