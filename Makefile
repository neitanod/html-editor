BINARY  := html-editor
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
BUILT   := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w -X main.Version=$(VERSION) -X main.BuildTime=$(BUILT)
PREFIX  ?= $(HOME)/bin

.PHONY: all build install uninstall run clean

all: build

build:
	go build -trimpath -ldflags "$(LDFLAGS)" -o $(BINARY) .

# Links the freshly built binary into PREFIX so `html-editor` works from any
# folder; rebuilding the project updates the installed command too.
install: build
	@mkdir -p $(PREFIX)
	@ln -sf "$(CURDIR)/$(BINARY)" "$(PREFIX)/$(BINARY)"
	@echo "linked $(PREFIX)/$(BINARY) -> $(CURDIR)/$(BINARY)"

uninstall:
	@rm -f "$(PREFIX)/$(BINARY)"
	@echo "removed $(PREFIX)/$(BINARY)"

run: build
	./$(BINARY)

clean:
	rm -f $(BINARY)
