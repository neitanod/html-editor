package main

import (
	"net/url"
	"strings"
	"testing"
)

func TestAssetNameFor(t *testing.T) {
	cases := []struct {
		raw         string
		contentType string
		want        string
	}{
		{"https://site.com/images/Foto Linda.JPG", "image/jpeg", "foto-linda.jpg"},
		{"https://cdn.site.com/a/b/c", "image/png", "c.png"},
		{"https://site.com/thing?v=2", "image/webp", "thing.webp"},
		{"https://www.site.com/", "image/gif", "site.com.gif"},
		{"https://site.com/logo.svg", "image/svg+xml", "logo.svg"},
		{"https://site.com/pic", "image/jpeg; charset=utf-8", "pic.jpg"},
	}
	for _, tc := range cases {
		parsed, err := url.Parse(tc.raw)
		if err != nil {
			t.Fatalf("parse %q: %v", tc.raw, err)
		}
		if got := assetNameFor(parsed, tc.contentType); got != tc.want {
			t.Errorf("assetNameFor(%q, %q) = %q, want %q", tc.raw, tc.contentType, got, tc.want)
		}
	}
}

// A remote server chooses the URL, so the derived name must never be able to
// point anywhere but the document folder.
func TestAssetNameNeverEscapesTheFolder(t *testing.T) {
	for _, raw := range []string{
		"https://evil.com/../../etc/passwd",
		"https://evil.com/%2e%2e%2f%2e%2e%2fetc/shadow",
		"https://evil.com/a/..%2f..%2fpasswd.png",
	} {
		parsed, err := url.Parse(raw)
		if err != nil {
			continue
		}
		name := assetNameFor(parsed, "image/png")
		if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
			t.Errorf("asset name derived from %q is unsafe: %q", raw, name)
		}
	}
}

func TestExtensionForContentType(t *testing.T) {
	cases := map[string]string{
		"image/png":                 ".png",
		"image/jpeg; charset=utf-8": ".jpg",
		"image/svg+xml":             ".svg",
		"":                          ".bin",
	}
	for input, want := range cases {
		if got := extensionForContentType(input); got != want {
			t.Errorf("extensionForContentType(%q) = %q, want %q", input, got, want)
		}
	}
}
