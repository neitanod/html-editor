package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenDocumentCreatesSkeleton(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "my-new-page.html")

	doc, err := OpenDocument(target)
	if err != nil {
		t.Fatalf("OpenDocument: %v", err)
	}
	if doc.Name != "my-new-page.html" || doc.Dir != dir {
		t.Fatalf("unexpected document metadata: %+v", doc)
	}

	content, err := doc.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	for _, want := range []string{"<!DOCTYPE html>", "<html lang=\"en\">", "<head>", "<body>",
		"<meta charset=\"utf-8\">", "<title>My new page</title>"} {
		if !strings.Contains(content, want) {
			t.Errorf("skeleton is missing %q\n%s", want, content)
		}
	}
}

func TestWriteKeepsSingleBackupAndIsAtomic(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "page.html")
	if err := os.WriteFile(target, []byte("<html>original</html>"), 0o644); err != nil {
		t.Fatal(err)
	}

	doc, err := OpenDocument(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := doc.Write("<html>first</html>"); err != nil {
		t.Fatal(err)
	}
	if err := doc.Write("<html>second</html>"); err != nil {
		t.Fatal(err)
	}

	backup, err := os.ReadFile(target + ".bak")
	if err != nil {
		t.Fatalf("backup missing: %v", err)
	}
	if string(backup) != "<html>original</html>" {
		t.Errorf("backup should hold the version found on disk, got %q", backup)
	}

	current, _ := doc.Read()
	if current != "<html>second</html>" {
		t.Errorf("unexpected content %q", current)
	}

	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Errorf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestScriptParkingRoundTrip(t *testing.T) {
	cases := []string{
		`<script>alert(1)</script>`,
		`<script type="module" src="app.js"></script>`,
		`<script async defer src="x.js"></script>`,
		`<script type='text/javascript'>var a = "<b>";</script>`,
		`<SCRIPT SRC="upper.js"></SCRIPT>`,
	}
	for _, original := range cases {
		parked := parkScripts(original)
		if !strings.Contains(parked, "text/x-html-editor-parked") {
			t.Errorf("script was not parked: %s", parked)
		}
		restored := unparkScripts(parked)
		if strings.Contains(restored, "html-editor") {
			t.Errorf("editor bookkeeping survived the round trip: %s", restored)
		}
		if !strings.EqualFold(normalise(restored), normalise(original)) {
			t.Errorf("round trip changed the script tag:\n  original: %s\n  restored: %s", original, restored)
		}
	}
}

// normalise makes the comparison insensitive to attribute spacing, which the
// parking rewrite is allowed to change.
func normalise(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func TestUnparkLeavesForeignScriptsAlone(t *testing.T) {
	original := `<script type="module">x()</script>`
	if got := unparkScripts(original); got != original {
		t.Errorf("unpark touched a script it did not park: %s", got)
	}
}

func TestUniqueAssetName(t *testing.T) {
	dir := t.TempDir()

	first := uniqueAssetName(dir, "My Photo.PNG", "image/png")
	if first != "my-photo.png" {
		t.Errorf("expected a sanitised name, got %q", first)
	}
	if err := os.WriteFile(filepath.Join(dir, first), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	second := uniqueAssetName(dir, "My Photo.PNG", "image/png")
	if second != "my-photo-2.png" {
		t.Errorf("expected a de-duplicated name, got %q", second)
	}

	pasted := uniqueAssetName(dir, "", "image/jpeg")
	if !strings.HasPrefix(pasted, "image-") || !strings.HasSuffix(pasted, ".jpg") {
		t.Errorf("clipboard images should get a timestamped name, got %q", pasted)
	}

	if name := uniqueAssetName(dir, "../../etc/passwd", "image/png"); strings.Contains(name, "/") {
		t.Errorf("asset names must not contain path separators, got %q", name)
	}
}

func TestResolveInsideDirRejectsEscapes(t *testing.T) {
	dir := t.TempDir()
	doc := &Document{Path: filepath.Join(dir, "index.html"), Dir: dir, Name: "index.html"}
	app := NewApp(doc, &Options{})

	// Traversal attempts are folded back into the folder rather than rejected,
	// which is what path.Clean on a rooted path guarantees; what matters is
	// that no resolved path ever points outside it.
	for _, attempt := range []string{"../secret.txt", "../../etc/passwd", "/etc/passwd",
		"images/../../outside.png", "..%2Fsecret.txt"} {
		resolved, ok := app.resolveInsideDir(attempt)
		if ok && !strings.HasPrefix(resolved, dir+string(os.PathSeparator)) {
			t.Errorf("%q resolved outside the document folder: %s", attempt, resolved)
		}
	}
	got, ok := app.resolveInsideDir("images/photo.png")
	if !ok || got != filepath.Join(dir, "images", "photo.png") {
		t.Errorf("legitimate path was rejected: %q ok=%v", got, ok)
	}
}

func TestTitleFromFileName(t *testing.T) {
	cases := map[string]string{
		"index.html":       "Index",
		"my-first-post.md": "My first post",
		"about_us.html":    "About us",
	}
	for input, want := range cases {
		if got := titleFromFileName(input); got != want {
			t.Errorf("titleFromFileName(%q) = %q, want %q", input, got, want)
		}
	}
}
