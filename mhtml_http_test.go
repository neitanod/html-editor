package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestApp(t *testing.T, dir string, readOnly bool) *App {
	t.Helper()
	doc, err := OpenDocument(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	return NewApp(doc, &Options{ReadOnly: readOnly, Serve: true, Version: "test"})
}

func TestExportEndpointsAnswerWithAnArchive(t *testing.T) {
	dir := writeSampleFolder(t)
	app := newTestApp(t, dir, false)

	// The download is what the browser gets: the archive itself, named after
	// the document so it arrives with a sensible file name.
	res := httptest.NewRecorder()
	app.Routes().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/export.mhtml", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("export download answered %d: %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Disposition"); !strings.Contains(got, `filename="index.mhtml"`) {
		t.Errorf("Content-Disposition = %q", got)
	}
	if !strings.Contains(res.Body.String(), "multipart/related") {
		t.Error("the download is not an archive")
	}

	// Saving next to the document leaves the file where it can be attached.
	res = httptest.NewRecorder()
	app.Routes().ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/api/export-mhtml", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("export to folder answered %d: %s", res.Code, res.Body.String())
	}
	var saved struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Size int    `json:"size"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Name != "index.mhtml" {
		t.Errorf("saved as %q", saved.Name)
	}
	info, err := os.Stat(filepath.Join(dir, "index.mhtml"))
	if err != nil {
		t.Fatalf("the archive was not written: %v", err)
	}
	if int(info.Size()) != saved.Size {
		t.Errorf("size reported %d, on disk %d", saved.Size, info.Size())
	}
}

func TestImportEndpointReplacesTheDocument(t *testing.T) {
	source := writeSampleFolder(t)
	archive, err := buildMHTML(mhtmlDocument{Name: "index.html", Dir: source, HTML: sampleHTML})
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "index.html"), []byte("<html><body>lo que había antes</body></html>"))
	app := newTestApp(t, dir, false)

	body := strings.NewReader(`{"data":"` + base64.StdEncoding.EncodeToString(archive) + `"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/import-mhtml", body)
	request.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.Routes().ServeHTTP(res, request)
	if res.Code != http.StatusOK {
		t.Fatalf("import answered %d: %s", res.Code, res.Body.String())
	}

	var result struct {
		Assets int      `json:"assets"`
		Stored []string `json:"stored"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Assets != 5 {
		t.Errorf("expected the five packed files, got %v", result.Stored)
	}

	written, err := os.ReadFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), "<h1>Hola</h1>") {
		t.Errorf("the imported document did not replace the old one:\n%s", written)
	}
	// Losing what was being edited would be unforgivable; the writer keeps it.
	backup, err := os.ReadFile(filepath.Join(dir, "index.html.bak"))
	if err != nil {
		t.Fatalf("no backup of the replaced document: %v", err)
	}
	if !strings.Contains(string(backup), "lo que había antes") {
		t.Errorf("the backup holds something else:\n%s", backup)
	}
}

func TestImportRefusesSomethingThatIsNotAnArchive(t *testing.T) {
	dir := t.TempDir()
	app := newTestApp(t, dir, false)

	body := strings.NewReader(`{"data":"` +
		base64.StdEncoding.EncodeToString([]byte("<html><body>una página</body></html>")) + `"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/import-mhtml", body)
	request.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.Routes().ServeHTTP(res, request)
	if res.Code != http.StatusBadRequest {
		t.Errorf("answered %d for something that is not an archive", res.Code)
	}
}

func TestReadOnlyModeWritesNothing(t *testing.T) {
	dir := writeSampleFolder(t)
	app := newTestApp(t, dir, true)

	for _, path := range []string{"/api/export-mhtml", "/api/import-mhtml"} {
		res := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"data":""}`))
		request.Header.Set("Content-Type", "application/json")
		app.Routes().ServeHTTP(res, request)
		if res.Code != http.StatusForbidden {
			t.Errorf("%s answered %d in read-only mode", path, res.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "index.mhtml")); !os.IsNotExist(err) {
		t.Error("read-only mode wrote the archive anyway")
	}

	// Reading is still allowed: looking at a document should let you take it
	// with you.
	res := httptest.NewRecorder()
	app.Routes().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/export.mhtml", nil))
	if res.Code != http.StatusOK {
		t.Errorf("the download answered %d in read-only mode", res.Code)
	}
}
