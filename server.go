package main

import (
	"embed"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed static templates
var embeddedFS embed.FS

const (
	shutdownGrace   = 5 * time.Second
	firstProbedPort = 8477
	portProbes      = 50
)

// ClientTracker counts live SSE connections. When the last one goes away the
// process exits after a short grace period, which is what makes the tool feel
// like a desktop app: close the tab, the command finishes.
type ClientTracker struct {
	mu      sync.Mutex
	count   int
	timer   *time.Timer
	serve   bool
	stopped bool
}

func NewClientTracker(serve bool) *ClientTracker {
	return &ClientTracker{serve: serve}
}

func (ct *ClientTracker) Add() {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	ct.count++
	ct.cancelLocked()
}

func (ct *ClientTracker) Remove() {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	ct.count--
	if ct.count < 0 {
		ct.count = 0
	}
	if ct.count == 0 {
		ct.scheduleLocked()
	}
}

func (ct *ClientTracker) Count() int {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	return ct.count
}

// CancelShutdown is called by the lifecycle beacon when a tab loads.
func (ct *ClientTracker) CancelShutdown() {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	ct.cancelLocked()
}

// ScheduleShutdown is called by the lifecycle beacon when a tab unloads.
func (ct *ClientTracker) ScheduleShutdown() {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if ct.count == 0 {
		ct.scheduleLocked()
	}
}

func (ct *ClientTracker) cancelLocked() {
	if ct.timer != nil {
		ct.timer.Stop()
		ct.timer = nil
	}
}

func (ct *ClientTracker) scheduleLocked() {
	if ct.serve || ct.stopped {
		return
	}
	ct.cancelLocked()
	ct.timer = time.AfterFunc(shutdownGrace, func() {
		ct.mu.Lock()
		idle := ct.count == 0
		ct.mu.Unlock()
		if idle {
			log.Println("no clients left, exiting")
			os.Exit(0)
		}
	})
}

// listen binds the HTTP listener, probing consecutive ports when none was
// requested so several documents can be edited at the same time.
func listen(host string, port int) (net.Listener, int, error) {
	if port != 0 {
		listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
		if err != nil {
			return nil, 0, err
		}
		return listener, listener.Addr().(*net.TCPAddr).Port, nil
	}
	for i := 0; i < portProbes; i++ {
		candidate := firstProbedPort + i
		listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, candidate))
		if err == nil {
			return listener, candidate, nil
		}
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:0", host))
	if err != nil {
		return nil, 0, err
	}
	return listener, listener.Addr().(*net.TCPAddr).Port, nil
}

func openBrowser(url string) {
	var err error
	switch runtime.GOOS {
	case "linux":
		err = exec.Command("xdg-open", url).Start()
	case "darwin":
		err = exec.Command("open", url).Start()
	case "windows":
		err = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		err = fmt.Errorf("unsupported platform %s", runtime.GOOS)
	}
	if err != nil {
		fmt.Printf("open %s in your browser\n", url)
	}
}

// uniqueAssetName builds a collision-free file name for a pasted asset, keeping
// the original name when it is usable and falling back to a timestamp.
func uniqueAssetName(dir, proposed, mimeType string) string {
	base := sanitizeFileName(proposed)
	ext := strings.ToLower(filepath.Ext(base))
	if ext == "" {
		ext = extensionForMime(mimeType)
		base += ext
	}
	stem := strings.TrimSuffix(base, ext)
	if stem == "" || stem == "image" || stem == "blob" {
		stem = "image-" + time.Now().Format("20060102-150405")
	}

	candidate := stem + ext
	for i := 2; ; i++ {
		if _, err := os.Stat(filepath.Join(dir, candidate)); os.IsNotExist(err) {
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d%s", stem, i, ext)
	}
}

func sanitizeFileName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.ToLower(name)
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
	}
	cleaned := strings.Trim(b.String(), ".-")
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return ""
	}
	return cleaned
}

func extensionForMime(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	case "image/avif":
		return ".avif"
	case "image/bmp":
		return ".bmp"
	default:
		return ".bin"
	}
}
