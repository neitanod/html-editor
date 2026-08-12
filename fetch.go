package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const (
	remoteAssetLimit   = 32 << 20 // 32 MB is plenty for a page asset
	remoteAssetTimeout = 25 * time.Second
)

// remoteClient downloads the assets of pasted content. The browser cannot do
// it: a cross-origin image fetched from the page is opaque, so the bytes have
// to travel through this process.
var remoteClient = &http.Client{
	Timeout: remoteAssetTimeout,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	},
}

// handleFetchAsset stores a remote URL next to the document and answers with
// the relative name to link it with.
func (a *App) handleFetchAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if a.opts.ReadOnly {
		writeJSONError(w, http.StatusForbidden, fmt.Errorf("read-only mode"))
		return
	}

	var payload struct {
		URL string `json:"url"`
	}
	if err := decodeJSON(r, w, &payload); err != nil {
		writeJSONError(w, http.StatusBadRequest, err)
		return
	}

	name, size, err := a.downloadAsset(payload.URL)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"name": name,
		"url":  "/doc/" + name,
		"size": size,
	})
}

func (a *App) downloadAsset(raw string) (string, int64, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", 0, fmt.Errorf("invalid URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", 0, fmt.Errorf("only http and https addresses can be downloaded")
	}
	if parsed.Host == "" {
		return "", 0, fmt.Errorf("the address has no host")
	}

	req, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("User-Agent", "html-editor/"+a.opts.Version+" (+https://github.com/neitanod/html-editor)")
	req.Header.Set("Accept", "image/*,*/*;q=0.8")

	res, err := remoteClient.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("could not reach %s: %w", parsed.Host, err)
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", 0, fmt.Errorf("%s answered %s", parsed.Host, res.Status)
	}

	contentType := res.Header.Get("Content-Type")
	name := assetNameFor(parsed, contentType)

	target := filepath.Join(a.doc.Dir, uniqueAssetName(a.doc.Dir, name, contentType))
	file, err := os.Create(target)
	if err != nil {
		return "", 0, err
	}

	written, err := io.Copy(file, io.LimitReader(res.Body, remoteAssetLimit+1))
	closeErr := file.Close()
	if err != nil {
		os.Remove(target)
		return "", 0, err
	}
	if closeErr != nil {
		os.Remove(target)
		return "", 0, closeErr
	}
	if written > remoteAssetLimit {
		os.Remove(target)
		return "", 0, fmt.Errorf("the file is larger than %d MB", remoteAssetLimit>>20)
	}

	return filepath.Base(target), written, nil
}

// assetNameFor derives a readable file name from the URL, falling back to the
// content type when the path carries no usable name (CDN URLs love those).
func assetNameFor(parsed *url.URL, contentType string) string {
	base := path.Base(parsed.Path)
	if base == "/" || base == "." || base == "" {
		base = ""
	}
	base = sanitizeFileName(base)

	ext := strings.ToLower(filepath.Ext(base))
	if ext == "" {
		ext = extensionForContentType(contentType)
		base = strings.TrimSuffix(base, ".") + ext
	}
	if strings.TrimSuffix(base, ext) == "" {
		host := sanitizeFileName(strings.TrimPrefix(parsed.Hostname(), "www."))
		if host == "" {
			host = "asset"
		}
		base = host + ext
	}
	return base
}

func extensionForContentType(contentType string) string {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = strings.TrimSpace(strings.Split(contentType, ";")[0])
	}
	if ext := extensionForMime(mediaType); ext != ".bin" {
		return ext
	}
	if exts, err := mime.ExtensionsByType(mediaType); err == nil && len(exts) > 0 {
		return exts[0]
	}
	return ".bin"
}

// decodeJSON is the shared request body reader, capped so a runaway client
// cannot fill memory.
func decodeJSON(r *http.Request, w http.ResponseWriter, target any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(target)
}
