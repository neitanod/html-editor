package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleHTML = `<!DOCTYPE html>
<html lang="es">
<head>
<title>Mi documento</title>
<link rel="stylesheet" href="estilo.css">
<style>body { background: url("fondo.png"); }</style>
</head>
<body>
<h1>Hola</h1>
<img src="img/foto.jpg" alt="una foto">
<img srcset="img/foto.jpg 1x, img/foto2.jpg 2x" src="img/foto.jpg">
<p style="background-image:url(fondo.png)">con estilo</p>
<a href="otra-pagina.html">un enlace</a>
<img src="https://example.com/remota.png">
</body>
</html>
`

func writeSampleFolder(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "index.html"), []byte(sampleHTML))
	mustWrite(t, filepath.Join(dir, "estilo.css"), []byte("h1 { color: red; background: url(img/textura.png); }"))
	mustWrite(t, filepath.Join(dir, "fondo.png"), []byte{0x89, 'P', 'N', 'G', 0x00, 0x01})
	mustWrite(t, filepath.Join(dir, "otra-pagina.html"), []byte("<html><body>otra</body></html>"))
	if err := os.MkdirAll(filepath.Join(dir, "img"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dir, "img", "foto.jpg"), bytes.Repeat([]byte{0xff, 0xd8, 0xff}, 40))
	mustWrite(t, filepath.Join(dir, "img", "foto2.jpg"), []byte{0xff, 0xd8, 0xfe})
	mustWrite(t, filepath.Join(dir, "img", "textura.png"), []byte{0x89, 'P', 'N', 'G', 0x02})
	return dir
}

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCollectReferencesFindsResourcesAndSkipsLinks(t *testing.T) {
	refs := collectReferences(sampleHTML)
	want := []string{"estilo.css", "fondo.png", "img/foto.jpg", "img/foto2.jpg", "https://example.com/remota.png"}
	for _, ref := range want {
		if !containsString(refs, ref) {
			t.Errorf("collectReferences missed %q; got %v", ref, refs)
		}
	}
	if containsString(refs, "otra-pagina.html") {
		t.Errorf("a link in <a href> is navigation, not a resource: %v", refs)
	}
}

func TestRewriteReferencesLeavesTheDocumentAloneWhenNothingChanges(t *testing.T) {
	if got := rewriteReferences(sampleHTML, func(ref string) string { return ref }); got != sampleHTML {
		t.Errorf("the document was rewritten without any address changing:\n%s", got)
	}
}

func TestBuildMHTMLPacksTheFolder(t *testing.T) {
	dir := writeSampleFolder(t)
	archive, err := buildMHTML(mhtmlDocument{
		Name: "index.html", Dir: dir, HTML: sampleHTML, Title: "Mi documento",
	})
	if err != nil {
		t.Fatalf("buildMHTML: %v", err)
	}
	text := string(archive)

	for _, header := range []string{"MIME-Version: 1.0", "multipart/related", `type="text/html"`} {
		if !strings.Contains(text, header) {
			t.Errorf("the archive is missing %q", header)
		}
	}
	// Every local file the document names, including the one only the
	// stylesheet knows about, has to be in there.
	for _, location := range []string{
		"http://html-editor.invalid/index.html",
		"http://html-editor.invalid/estilo.css",
		"http://html-editor.invalid/fondo.png",
		"http://html-editor.invalid/img/foto.jpg",
		"http://html-editor.invalid/img/foto2.jpg",
		"http://html-editor.invalid/img/textura.png",
	} {
		if !strings.Contains(text, "Content-Location: "+location) {
			t.Errorf("the archive does not carry %s", location)
		}
	}
	if strings.Contains(text, "otra-pagina.html\r\n") && strings.Contains(text, "Content-Location: http://html-editor.invalid/otra-pagina.html") {
		t.Error("a linked page is not a resource and should stay out of the archive")
	}
	if strings.Contains(text, dir) {
		t.Error("the archive leaks the local path of the folder")
	}
	if !strings.Contains(text, "Subject: Mi documento") {
		t.Error("the title should travel as the Subject")
	}
	// The HTML has to stay readable: that is the point of quoted-printable.
	if !strings.Contains(text, "<h1>Hola</h1>") {
		t.Error("the HTML is not stored readable")
	}
}

func TestMHTMLRoundTrip(t *testing.T) {
	dir := writeSampleFolder(t)
	archive, err := buildMHTML(mhtmlDocument{Name: "index.html", Dir: dir, HTML: sampleHTML})
	if err != nil {
		t.Fatalf("buildMHTML: %v", err)
	}

	parsed, err := parseMHTML(archive)
	if err != nil {
		t.Fatalf("parseMHTML: %v", err)
	}
	if string(parsed.Root.Data) != sampleHTML {
		t.Errorf("the HTML did not survive the round trip:\n%s", parsed.Root.Data)
	}

	target := t.TempDir()
	html, stored, err := importMHTML(parsed, target)
	if err != nil {
		t.Fatalf("importMHTML: %v", err)
	}
	if len(stored) != 5 {
		t.Errorf("expected the five files of the folder, got %v", stored)
	}

	// The imported document points at files that are really there.
	for _, ref := range collectReferences(html) {
		if strings.HasPrefix(ref, "http") {
			continue
		}
		if _, err := os.Stat(filepath.Join(target, ref)); err != nil {
			t.Errorf("the imported document points at %q, which was not unpacked", ref)
		}
	}
	if !containsString(collectReferences(html), "https://example.com/remota.png") {
		t.Error("an address that was remote has to stay remote")
	}

	// Bytes are bytes: the picture has to come back identical.
	original, err := os.ReadFile(filepath.Join(dir, "img", "foto.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	imported, err := os.ReadFile(filepath.Join(target, "foto.jpg"))
	if err != nil {
		t.Fatalf("foto.jpg was not unpacked: %v", err)
	}
	if !bytes.Equal(original, imported) {
		t.Error("the unpacked image differs from the original")
	}

	// The stylesheet came in with its own address, which has to be rewritten
	// too or the background image breaks.
	css, err := os.ReadFile(filepath.Join(target, "estilo.css"))
	if err != nil {
		t.Fatalf("estilo.css was not unpacked: %v", err)
	}
	if strings.Contains(string(css), "img/textura.png") {
		t.Errorf("the stylesheet still points at the original folder: %s", css)
	}
	if !strings.Contains(string(css), "textura.png") {
		t.Errorf("the stylesheet lost its background: %s", css)
	}
}

// A file saved by Chrome: absolute addresses, base64 bodies, quoted-printable
// HTML and a part referenced by Content-ID.
const chromeArchive = "From: <Saved by Blink>\r\n" +
	"Subject: =?utf-8?Q?Una_p=C3=A1gina?=\r\n" +
	"MIME-Version: 1.0\r\n" +
	"Content-Type: multipart/related; type=\"text/html\"; boundary=\"----MultipartBoundary--x--\"\r\n" +
	"\r\n" +
	"------MultipartBoundary--x--\r\n" +
	"Content-Type: text/html\r\n" +
	"Content-Transfer-Encoding: quoted-printable\r\n" +
	"Content-Location: https://sitio.example/pagina/index.html\r\n" +
	"\r\n" +
	"<html><head><title>Una p=C3=A1gina</title></head><body>\r\n" +
	"<img src=3D\"/estaticos/logo.png\">\r\n" +
	"<img src=3D\"cid:incrustada\">\r\n" +
	"<img src=3D\"https://otro.example/lejos.png\">\r\n" +
	"</body></html>\r\n" +
	"------MultipartBoundary--x--\r\n" +
	"Content-Type: image/png\r\n" +
	"Content-Transfer-Encoding: base64\r\n" +
	"Content-Location: https://sitio.example/estaticos/logo.png\r\n" +
	"\r\n" +
	"aGVsbG8=\r\n" +
	"------MultipartBoundary--x--\r\n" +
	"Content-Type: image/gif\r\n" +
	"Content-Transfer-Encoding: base64\r\n" +
	"Content-ID: <incrustada>\r\n" +
	"\r\n" +
	"Ym9udW0=\r\n" +
	"------MultipartBoundary--x----\r\n"

func TestImportArchiveSavedByAnotherBrowser(t *testing.T) {
	parsed, err := parseMHTML([]byte(chromeArchive))
	if err != nil {
		t.Fatalf("parseMHTML: %v", err)
	}
	if parsed.Subject != "Una página" {
		t.Errorf("the encoded Subject was not decoded: %q", parsed.Subject)
	}
	if !strings.Contains(string(parsed.Root.Data), "<title>Una página</title>") {
		t.Errorf("quoted-printable was not decoded: %s", parsed.Root.Data)
	}

	dir := t.TempDir()
	html, stored, err := importMHTML(parsed, dir)
	if err != nil {
		t.Fatalf("importMHTML: %v", err)
	}
	if len(stored) != 2 {
		t.Fatalf("expected both images, got %v", stored)
	}

	logo, err := os.ReadFile(filepath.Join(dir, "logo.png"))
	if err != nil {
		t.Fatalf("the logo kept neither its name nor its place: %v", err)
	}
	if string(logo) != "hello" {
		t.Errorf("base64 was not decoded: %q", logo)
	}
	if strings.Contains(html, "/estaticos/logo.png") {
		t.Errorf("an absolute address was not rewritten:\n%s", html)
	}
	if strings.Contains(html, "cid:incrustada") {
		t.Errorf("a cid: address was not rewritten:\n%s", html)
	}
	if !strings.Contains(html, "https://otro.example/lejos.png") {
		t.Errorf("an address the archive does not carry has to stay as it was:\n%s", html)
	}
}

func TestParseRejectsSomethingElse(t *testing.T) {
	if _, err := parseMHTML([]byte("<html><body>just a page</body></html>")); err == nil {
		t.Error("a plain HTML file is not an archive and should be refused")
	}
}

func TestLocalTargetRefusesWhatIsNotInTheFolder(t *testing.T) {
	dir := writeSampleFolder(t)
	for _, ref := range []string{
		"../../etc/passwd",
		"/etc/passwd",
		"https://example.com/x.png",
		"data:image/png;base64,AAAA",
		"no-existe.png",
	} {
		if _, _, ok := localTarget(dir, ".", ref); ok {
			t.Errorf("localTarget accepted %q", ref)
		}
	}
	if _, _, ok := localTarget(dir, ".", "img/foto.jpg"); !ok {
		t.Error("localTarget refused a file that is right there")
	}
}

func TestExportNameSwapsTheExtension(t *testing.T) {
	cases := map[string]string{
		"index.html": "index.mhtml",
		"page.htm":   "page.mhtml",
		"notes":      "notes.mhtml",
	}
	for input, want := range cases {
		if got := exportName(input); got != want {
			t.Errorf("exportName(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestTitleOfReadsTheDocumentTitle(t *testing.T) {
	if got := titleOf(sampleHTML); got != "Mi documento" {
		t.Errorf("titleOf = %q", got)
	}
	if got := titleOf("<html><body>sin título</body></html>"); got != "" {
		t.Errorf("titleOf = %q, want empty", got)
	}
}

func TestBoundaryNeverAppearsInTheDocument(t *testing.T) {
	html := "<html><body>----=_NextPart_html_editor</body></html>"
	dir := t.TempDir()
	archive, err := buildMHTML(mhtmlDocument{Name: "index.html", Dir: dir, HTML: html})
	if err != nil {
		t.Fatalf("buildMHTML: %v", err)
	}
	parsed, err := parseMHTML(archive)
	if err != nil {
		t.Fatalf("a document containing the default boundary broke the archive: %v", err)
	}
	if string(parsed.Root.Data) != html {
		t.Errorf("the document did not survive: %q", parsed.Root.Data)
	}
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
