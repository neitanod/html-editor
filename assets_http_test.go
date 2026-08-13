package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// postAsset sends what the editor sends when a picture has to land in the
// folder. An empty "overwrite" is the paste; a name in it is the image editor
// asking for the file it came from to be replaced.
func postAsset(t *testing.T, app *App, name, mime, overwrite string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"name":      name,
		"mime":      mime,
		"overwrite": overwrite,
		"data":      base64.StdEncoding.EncodeToString(data),
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/assets", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.Routes().ServeHTTP(res, req)
	return res
}

func TestAssetsWriteACopyWithoutTouchingTheOriginal(t *testing.T) {
	dir := writeSampleFolder(t)
	app := newTestApp(t, dir, false)

	res := postAsset(t, app, "foto-crop.jpg", "image/jpeg", "", []byte{0xff, 0xd8, 0x11})
	if res.Code != http.StatusOK {
		t.Fatalf("storing a copy answered %d: %s", res.Code, res.Body.String())
	}
	var stored struct {
		Name      string `json:"name"`
		Overwrote bool   `json:"overwrote"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Name != "foto-crop.jpg" || stored.Overwrote {
		t.Fatalf("stored as %q, overwrote=%t", stored.Name, stored.Overwrote)
	}
	// The picture the crop was made from is still where the document left it.
	if data := mustRead(t, filepath.Join(dir, "img", "foto.jpg")); len(data) != 120 {
		t.Errorf("the original changed: %d bytes", len(data))
	}
}

func TestAssetsOverwriteReplacesTheFileInPlace(t *testing.T) {
	dir := writeSampleFolder(t)
	app := newTestApp(t, dir, false)
	before, err := os.ReadDir(filepath.Join(dir, "img"))
	if err != nil {
		t.Fatal(err)
	}

	res := postAsset(t, app, "img/foto.jpg", "image/jpeg", "img/foto.jpg", []byte{0xff, 0xd8, 0x42})
	if res.Code != http.StatusOK {
		t.Fatalf("overwriting answered %d: %s", res.Code, res.Body.String())
	}
	var stored struct {
		Name      string `json:"name"`
		URL       string `json:"url"`
		Overwrote bool   `json:"overwrote"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	// The document keeps pointing at the same file, which is the whole point:
	// nothing in the HTML has to change for the new pixels to show up.
	if stored.Name != "img/foto.jpg" || stored.URL != "/doc/img/foto.jpg" || !stored.Overwrote {
		t.Fatalf("answered %+v", stored)
	}
	if got := mustRead(t, filepath.Join(dir, "img", "foto.jpg")); string(got) != string([]byte{0xff, 0xd8, 0x42}) {
		t.Errorf("the file still holds the old picture: % x", got)
	}
	// And no second file appeared, which is what the whole feature is for.
	after, err := os.ReadDir(filepath.Join(dir, "img"))
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Errorf("the folder went from %d files to %d", len(before), len(after))
	}
}

func TestAssetsOverwriteAcceptsJpegUnderEitherSpelling(t *testing.T) {
	dir := writeSampleFolder(t)
	mustWrite(t, filepath.Join(dir, "retrato.jpeg"), []byte{0xff, 0xd8, 0x01})
	app := newTestApp(t, dir, false)

	res := postAsset(t, app, "retrato.jpeg", "image/jpeg", "retrato.jpeg", []byte{0xff, 0xd8, 0x99})
	if res.Code != http.StatusOK {
		t.Fatalf("overwriting a .jpeg answered %d: %s", res.Code, res.Body.String())
	}
}

func TestAssetsOverwriteRefusesWhatItMustNotTouch(t *testing.T) {
	dir := writeSampleFolder(t)
	outside := filepath.Join(filepath.Dir(dir), "vecino.png")
	mustWrite(t, outside, []byte("untouched"))

	cases := []struct {
		name      string
		overwrite string
		mime      string
		why       string
	}{
		{"outside the folder", "../vecino.png", "image/png", "escaping the document folder"},
		// This one cleans back into the folder, which is exactly why it is
		// refused: the answer would be a file the browser was never showing.
		{"climbing and coming back", "img/../fondo.png", "image/png", "a name that climbs"},
		{"not there yet", "img/nueva.png", "image/png", "a name nothing answers to"},
		{"the document itself", "index.html", "image/png", "the page being edited"},
		{"a folder", "img", "image/png", "a directory"},
		{"another format", "fondo.png", "image/jpeg", "a JPEG inside a .png"},
		{"a format canvas cannot write", "fondo.png", "", "no format at all"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := newTestApp(t, dir, false)
			res := postAsset(t, app, tc.overwrite, tc.mime, tc.overwrite, []byte{0x89, 'P', 'N', 'G', 0x07})
			if res.Code != http.StatusBadRequest {
				t.Fatalf("%s answered %d: %s", tc.why, res.Code, res.Body.String())
			}
		})
	}

	// Nothing on the other side of the folder was written, and the document is
	// still the document.
	if got := mustRead(t, outside); string(got) != "untouched" {
		t.Errorf("the neighbour file was written: %q", got)
	}
	if got := mustRead(t, filepath.Join(dir, "index.html")); string(got) != sampleHTML {
		t.Error("the document was written over as if it were a picture")
	}
	if _, err := os.Stat(filepath.Join(dir, "img", "nueva.png")); err == nil {
		t.Error("a refused overwrite created the file anyway")
	}
}

func TestAssetsOverwriteIsRefusedInReadOnlyMode(t *testing.T) {
	dir := writeSampleFolder(t)
	app := newTestApp(t, dir, true)

	res := postAsset(t, app, "fondo.png", "image/png", "fondo.png", []byte{0x89, 'P', 'N', 'G', 0x09})
	if res.Code != http.StatusForbidden {
		t.Fatalf("read-only answered %d: %s", res.Code, res.Body.String())
	}
	if got := mustRead(t, filepath.Join(dir, "fondo.png")); len(got) != 6 {
		t.Errorf("the file changed in read-only mode: % x", got)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(fmt.Errorf("reading %s: %w", path, err))
	}
	return data
}
