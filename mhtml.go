package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// MHTML (RFC 2557) is a mail message that carries a page: one multipart/related
// body whose first part is the HTML and whose remaining parts are the files it
// needs, each labelled with the address it had. Nothing is compressed and the
// HTML is stored readable, so the archive stays a text file you can open with a
// pager. It is the "single file web page" of Chrome, Edge and Word, which is
// what makes it useful here: one file to send, and still editable afterwards.
//
// The editor keeps documents as a folder (index.html plus its assets) because
// that is the better shape to work in. MHTML is the delivery shape: exporting
// packs the folder, importing unpacks it back into one.

const (
	// Relative addresses in the HTML need an absolute base to resolve against.
	// A .invalid host (RFC 2606) can never reach a real site and, unlike a
	// file:// base, keeps local paths out of a file that travels by mail.
	mhtmlBase = "http://html-editor.invalid/"

	// Longest line written for base64 payloads, as mail expects.
	mhtmlLineLimit = 76

	mhtmlSizeLimit = 256 << 20
)

// mhtmlDocument is what an export packs: the HTML entry point plus the folder
// its relative addresses resolve in.
type mhtmlDocument struct {
	Name  string // file name of the HTML, e.g. "index.html"
	Dir   string // folder holding the document and its assets
	HTML  string
	Title string
	Date  time.Time // omitted from the archive when zero
}

// mhtmlPart is one entry of a parsed archive.
type mhtmlPart struct {
	Location  string // Content-Location: the address the file had
	ContentID string // Content-ID, referenced from the HTML as cid:...
	MediaType string
	Data      []byte
}

// mhtmlArchive is a parsed .mhtml: the HTML entry point and everything else.
type mhtmlArchive struct {
	Subject string
	Root    mhtmlPart
	Parts   []mhtmlPart
}

/* ------------------------------------------------------------------ export */

// buildMHTML packs the document and every local file it references into a
// multipart/related archive. Addresses that point at other sites are left
// alone: they stay remote, exactly as they are in the folder.
func buildMHTML(doc mhtmlDocument) ([]byte, error) {
	base, err := url.Parse(mhtmlBase)
	if err != nil {
		return nil, err
	}
	rootLocation := base.ResolveReference(&url.URL{Path: doc.Name}).String()

	assets, err := collectAssets(doc)
	if err != nil {
		return nil, err
	}

	boundary := chooseBoundary(doc.HTML)

	var out bytes.Buffer
	writeHeader(&out, "From", "<Saved by html-editor>")
	if title := strings.TrimSpace(doc.Title); title != "" {
		writeHeader(&out, "Subject", mime.QEncoding.Encode("utf-8", title))
	}
	if !doc.Date.IsZero() {
		writeHeader(&out, "Date", doc.Date.Format(time.RFC1123Z))
	}
	writeHeader(&out, "MIME-Version", "1.0")
	writeHeader(&out, "Content-Type",
		fmt.Sprintf("multipart/related;\r\n\ttype=\"text/html\";\r\n\tboundary=\"%s\"", boundary))
	writeHeader(&out, "Snapshot-Content-Location", rootLocation)
	out.WriteString("\r\n")

	writer := multipart.NewWriter(&out)
	if err := writer.SetBoundary(boundary); err != nil {
		return nil, err
	}

	part, err := writer.CreatePart(textproto.MIMEHeader{
		"Content-Type":              {"text/html; charset=\"utf-8\""},
		"Content-Transfer-Encoding": {"quoted-printable"},
		"Content-Location":          {rootLocation},
	})
	if err != nil {
		return nil, err
	}
	qp := quotedprintable.NewWriter(part)
	if _, err := io.WriteString(qp, doc.HTML); err != nil {
		return nil, err
	}
	if err := qp.Close(); err != nil {
		return nil, err
	}

	for _, asset := range assets {
		part, err := writer.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {asset.mediaType},
			"Content-Transfer-Encoding": {"base64"},
			"Content-Location":          {asset.location},
		})
		if err != nil {
			return nil, err
		}
		if err := writeBase64(part, asset.data); err != nil {
			return nil, err
		}
	}

	if err := writer.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

type packedAsset struct {
	location  string
	mediaType string
	data      []byte
}

// collectAssets walks the document, and then the stylesheets it finds, reading
// every file that lives inside the document folder. A stylesheet names images
// of its own, so the walk keeps going until nothing new turns up.
func collectAssets(doc mhtmlDocument) ([]packedAsset, error) {
	base, err := url.Parse(mhtmlBase)
	if err != nil {
		return nil, err
	}

	var assets []packedAsset
	seen := map[string]bool{}

	type pending struct {
		refs []string
		dir  string // folder the refs resolve in, relative to the document
	}
	queue := []pending{{refs: collectReferences(doc.HTML), dir: "."}}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		for _, ref := range current.refs {
			rel, target, ok := localTarget(doc.Dir, current.dir, ref)
			if !ok || seen[rel] {
				continue
			}
			data, err := os.ReadFile(target)
			if err != nil {
				// A broken address is a broken address: the archive carries
				// what the folder has, and the rest stays as it was written.
				continue
			}
			seen[rel] = true

			location := base.ResolveReference(&url.URL{Path: rel})
			if parsed, err := url.Parse(ref); err == nil {
				location.RawQuery = parsed.RawQuery
			}

			mediaType := mediaTypeFor(target)
			assets = append(assets, packedAsset{
				location:  location.String(),
				mediaType: mediaType,
				data:      data,
			})

			if strings.HasPrefix(mediaType, "text/css") {
				queue = append(queue, pending{
					refs: collectCSSReferences(string(data)),
					dir:  path.Dir(rel),
				})
			}
		}
	}
	return assets, nil
}

// localTarget maps an address found in the document to a file inside the
// document folder, refusing anything remote, absolute or above the folder.
func localTarget(dir, refDir, ref string) (rel string, target string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(ref))
	if err != nil || parsed.Scheme != "" || parsed.Host != "" {
		return "", "", false
	}
	if parsed.Path == "" || strings.HasPrefix(parsed.Path, "/") {
		return "", "", false
	}
	rel = path.Clean(path.Join(refDir, parsed.Path))
	if rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", "", false
	}
	target = filepath.Join(dir, filepath.FromSlash(rel))
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		return "", "", false
	}
	return rel, target, true
}

func mediaTypeFor(file string) string {
	if ctype := mime.TypeByExtension(filepath.Ext(file)); ctype != "" {
		return ctype
	}
	return "application/octet-stream"
}

// chooseBoundary picks a separator that cannot appear in the payload. The HTML
// travels quoted-printable, which leaves ordinary text untouched, so a document
// that happens to contain the boundary would cut the archive in half.
func chooseBoundary(content string) string {
	candidate := "----=_NextPart_html_editor"
	for i := 2; strings.Contains(content, candidate); i++ {
		candidate = fmt.Sprintf("----=_NextPart_html_editor_%d", i)
	}
	return candidate
}

func writeHeader(out *bytes.Buffer, name, value string) {
	out.WriteString(name)
	out.WriteString(": ")
	out.WriteString(value)
	out.WriteString("\r\n")
}

func writeBase64(w io.Writer, data []byte) error {
	encoded := base64.StdEncoding.EncodeToString(data)
	for len(encoded) > mhtmlLineLimit {
		if _, err := io.WriteString(w, encoded[:mhtmlLineLimit]+"\r\n"); err != nil {
			return err
		}
		encoded = encoded[mhtmlLineLimit:]
	}
	_, err := io.WriteString(w, encoded+"\r\n")
	return err
}

/* ------------------------------------------------------------------ import */

// parseMHTML reads an archive written by this editor, by Chrome, by Edge or by
// Word. Only the entry point has to be HTML; everything else is taken as is.
func parseMHTML(data []byte) (*mhtmlArchive, error) {
	message, err := mail.ReadMessage(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("this does not look like an .mhtml archive: %w", err)
	}

	archive := &mhtmlArchive{}
	if subject := message.Header.Get("Subject"); subject != "" {
		decoded, err := new(mime.WordDecoder).DecodeHeader(subject)
		if err == nil {
			archive.Subject = decoded
		} else {
			archive.Subject = subject
		}
	}

	mediaType, params, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil {
		return nil, fmt.Errorf("unreadable Content-Type: %w", err)
	}

	// A page with no assets is sometimes saved as a bare HTML message.
	if !strings.HasPrefix(mediaType, "multipart/") {
		if !strings.HasPrefix(mediaType, "text/html") {
			return nil, fmt.Errorf("the archive carries %s instead of HTML", mediaType)
		}
		body, err := decodePart(message.Header.Get("Content-Transfer-Encoding"), message.Body)
		if err != nil {
			return nil, err
		}
		archive.Root = mhtmlPart{
			Location:  message.Header.Get("Content-Location"),
			MediaType: mediaType,
			Data:      normalizeLineEndings(mediaType, body),
		}
		return archive, nil
	}

	boundary := params["boundary"]
	if boundary == "" {
		return nil, fmt.Errorf("the archive has no part separator")
	}

	var parts []mhtmlPart
	reader := multipart.NewReader(message.Body, boundary)
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("truncated archive: %w", err)
		}
		// multipart.Part already decodes quoted-printable and drops the header
		// when it does; base64 is left for us.
		body, err := decodePart(part.Header.Get("Content-Transfer-Encoding"), part)
		part.Close()
		if err != nil {
			return nil, err
		}
		entryType, _, err := mime.ParseMediaType(part.Header.Get("Content-Type"))
		if err != nil {
			entryType = "application/octet-stream"
		}
		parts = append(parts, mhtmlPart{
			Location:  part.Header.Get("Content-Location"),
			ContentID: strings.Trim(part.Header.Get("Content-ID"), "<>"),
			MediaType: entryType,
			Data:      normalizeLineEndings(entryType, body),
		})
	}

	rootIndex := rootPartIndex(parts, params["start"])
	if rootIndex == -1 {
		return nil, fmt.Errorf("the archive has no HTML part")
	}
	archive.Root = parts[rootIndex]
	archive.Parts = append(parts[:rootIndex:rootIndex], parts[rootIndex+1:]...)

	if archive.Root.Location == "" {
		archive.Root.Location = message.Header.Get("Snapshot-Content-Location")
	}
	return archive, nil
}

// rootPartIndex finds the entry point: the part named by the "start" parameter
// when there is one, and otherwise the first HTML part.
func rootPartIndex(parts []mhtmlPart, start string) int {
	if start = strings.Trim(start, "<>"); start != "" {
		for i, part := range parts {
			if part.ContentID == start {
				return i
			}
		}
	}
	for i, part := range parts {
		if strings.HasPrefix(part.MediaType, "text/html") {
			return i
		}
	}
	return -1
}

// normalizeLineEndings undoes the CRLF that mail uses as its canonical line
// ending. Text that goes back to a file has to come back the way documents are
// written here; bytes that are not text are never touched.
func normalizeLineEndings(mediaType string, data []byte) []byte {
	if !strings.HasPrefix(mediaType, "text/") {
		return data
	}
	return bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
}

func decodePart(encoding string, body io.Reader) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		return io.ReadAll(base64.NewDecoder(base64.StdEncoding, body))
	case "quoted-printable":
		return io.ReadAll(quotedprintable.NewReader(body))
	default:
		return io.ReadAll(body)
	}
}

// importMHTML unpacks an archive into dir: every part lands next to the
// document as a file of its own and the HTML comes back pointing at them,
// which leaves the result indistinguishable from a document created here.
//
// reserved names the files the caller is about to write itself — the document
// among them — so an archived part carrying that same name cannot take it and
// then be overwritten.
func importMHTML(archive *mhtmlArchive, dir string, reserved ...string) (html string, stored []string, err error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", nil, err
	}

	taken := map[string]bool{}
	for _, name := range reserved {
		taken[name] = true
	}

	base := parseBase(archive.Root.Location)

	// Names are handed out while the files are written, so the collision check
	// of uniqueAssetName sees the ones already taken by this same import.
	names := map[string]string{} // absolute address or cid: → local file name
	type written struct {
		name string
		part mhtmlPart
	}
	var files []written

	for _, part := range archive.Parts {
		address := absoluteAddress(base, part.Location)
		if address != "" && names[address] != "" {
			continue // the first part with an address wins
		}
		proposed := assetNameForLocation(part)
		name := uniqueAssetName(dir, proposed, part.MediaType)
		for taken[name] {
			proposed = "asset-" + proposed
			name = uniqueAssetName(dir, proposed, part.MediaType)
		}
		if err := os.WriteFile(filepath.Join(dir, name), part.Data, 0o644); err != nil {
			return "", nil, err
		}
		if address != "" {
			names[address] = name
		}
		if part.ContentID != "" {
			names["cid:"+part.ContentID] = name
		}
		files = append(files, written{name: name, part: part})
		stored = append(stored, name)
	}

	// Stylesheets carry addresses of their own and are rewritten in place.
	for _, file := range files {
		if !strings.HasPrefix(file.part.MediaType, "text/css") {
			continue
		}
		cssBase := parseBase(absoluteAddress(base, file.part.Location))
		rewritten := rewriteCSS(string(file.part.Data), func(ref string) string {
			return localNameFor(names, cssBase, ref)
		})
		if rewritten == string(file.part.Data) {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, file.name), []byte(rewritten), 0o644); err != nil {
			return "", nil, err
		}
	}

	html = rewriteReferences(string(archive.Root.Data), func(ref string) string {
		return localNameFor(names, base, ref)
	})
	return html, stored, nil
}

// localNameFor answers with the file the address ended up in, and with the
// address itself when the archive did not carry it — a page that links to a
// site keeps linking to it.
func localNameFor(names map[string]string, base *url.URL, ref string) string {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(strings.ToLower(trimmed), "data:") {
		return ref
	}
	if strings.HasPrefix(strings.ToLower(trimmed), "cid:") {
		if name := names["cid:"+strings.Trim(trimmed[4:], "<>")]; name != "" {
			return name
		}
		return ref
	}
	if name := names[absoluteAddress(base, trimmed)]; name != "" {
		return name
	}
	return ref
}

func parseBase(location string) *url.URL {
	parsed, err := url.Parse(strings.TrimSpace(location))
	if err != nil {
		return nil
	}
	return parsed
}

// absoluteAddress resolves an address the way a reader would, so a relative
// src and the Content-Location of the part it points at meet at the same
// string.
func absoluteAddress(base *url.URL, ref string) string {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	if base != nil && base.IsAbs() {
		parsed = base.ResolveReference(parsed)
	}
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return parsed.String()
}

// assetNameForLocation names the file an archived part is unpacked into,
// reusing the name it had in its address whenever there is one.
func assetNameForLocation(part mhtmlPart) string {
	if parsed, err := url.Parse(strings.TrimSpace(part.Location)); err == nil && parsed.Path != "" {
		if name := assetNameFor(parsed, part.MediaType); name != "" {
			return name
		}
	}
	return "asset" + extensionForContentType(part.MediaType)
}

/* --------------------------------------------------------------- documents */

// exportName is the archive a document is packed into: the document name with
// its extension swapped, so notes/index.html becomes notes/index.mhtml.
func exportName(docName string) string {
	base := strings.TrimSuffix(docName, filepath.Ext(docName))
	if base == "" {
		base = "document"
	}
	return base + ".mhtml"
}

// isMHTMLName reports whether a path names an archive rather than a document.
func isMHTMLName(name string) bool {
	switch strings.ToLower(filepath.Ext(strings.TrimSpace(name))) {
	case ".mhtml", ".mht":
		return true
	}
	return false
}

// titleOf digs the <title> out of the document, which becomes the Subject of
// the archive and is what a mail client shows as its name.
func titleOf(html string) string {
	lower := strings.ToLower(html)
	open := strings.Index(lower, "<title")
	if open == -1 {
		return ""
	}
	start := strings.Index(lower[open:], ">")
	if start == -1 {
		return ""
	}
	start += open + 1
	end := strings.Index(lower[start:], "</title>")
	if end == -1 {
		return ""
	}
	return strings.TrimSpace(unescapeHTMLText(html[start : start+end]))
}

func unescapeHTMLText(s string) string {
	return strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&amp;", "&").Replace(s)
}
