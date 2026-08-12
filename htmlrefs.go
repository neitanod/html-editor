package main

import (
	"html"
	"regexp"
	"sort"
	"strings"
)

// Finding the resources a document depends on is needed twice: to pack them
// into an .mhtml archive, and to point the HTML of an imported archive at the
// files unpacked next to it. Both directions are the same walk, so they share
// one scanner: visit receives every address in the document and returns the
// address to write in its place (returning it unchanged rewrites nothing).
//
// The walk is a regular expression pass rather than a parse tree because the
// document is written back byte for byte: everything outside the addresses,
// including the author's formatting, has to survive untouched.

var (
	tagRe   = regexp.MustCompile(`(?is)<([a-z][a-z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>`)
	attrRe  = regexp.MustCompile(`(?is)([a-z][a-z0-9-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
	cssURL  = regexp.MustCompile(`(?i)url\(\s*("[^"]*"|'[^']*'|[^)]*?)\s*\)`)
	cssImp  = regexp.MustCompile(`(?i)@import\s+("[^"]*"|'[^']*')`)
	styleRe = regexp.MustCompile(`(?is)(<style\b(?:"[^"]*"|'[^']*'|[^>"'])*>)(.*?)(</style>)`)
)

// resourceAttrs lists, per tag, the attributes that name a file the document
// needs to render. Links in <a href> are navigation, not resources, which is
// why href only counts inside <link>.
var resourceAttrs = map[string][]string{
	"img":    {"src", "srcset"},
	"source": {"src", "srcset"},
	"image":  {"href", "xlink:href"},
	"video":  {"src", "poster"},
	"audio":  {"src"},
	"track":  {"src"},
	"embed":  {"src"},
	"iframe": {"src"},
	"input":  {"src"},
	"script": {"src"},
	"link":   {"href"},
	"object": {"data"},
	"body":   {"background"},
	"table":  {"background"},
	"td":     {"background"},
	"th":     {"background"},
}

// srcset holds several addresses with their descriptors ("photo.jpg 2x"), so
// it is split apart and reassembled instead of being replaced whole.
var srcsetAttrs = map[string]bool{"srcset": true, "imagesrcset": true}

type replacement struct {
	start, end int
	value      string
}

// rewriteReferences walks every resource address in the document and replaces
// it with what visit returns. Addresses are handed over already decoded (HTML
// entities resolved) and are re-escaped on the way back.
func rewriteReferences(document string, visit func(ref string) string) string {
	var edits []replacement

	// An address inside an attribute value: the recorded range is the value
	// itself, without the quotes, so the quoting style is preserved.
	addAttr := func(value string, start, end int, isSrcset bool) {
		raw := value
		quote := byte(0)
		if len(raw) >= 2 && (raw[0] == '"' || raw[0] == '\'') && raw[len(raw)-1] == raw[0] {
			quote = raw[0]
			raw = raw[1 : len(raw)-1]
			start++
			end--
		}
		var replaced string
		if isSrcset {
			replaced = rewriteSrcset(raw, visit)
		} else {
			replaced = escapeAttrValue(visit(html.UnescapeString(raw)), quote)
		}
		if replaced != raw {
			edits = append(edits, replacement{start, end, replaced})
		}
	}

	for _, tag := range tagRe.FindAllStringSubmatchIndex(document, -1) {
		name := strings.ToLower(document[tag[2]:tag[3]])
		wanted := resourceAttrs[name]
		attrsStart, attrsEnd := tag[4], tag[5]
		if attrsStart < 0 {
			continue
		}
		attrs := document[attrsStart:attrsEnd]

		for _, m := range attrRe.FindAllStringSubmatchIndex(attrs, -1) {
			attrName := strings.ToLower(attrs[m[2]:m[3]])
			value := attrs[m[4]:m[5]]
			start, end := attrsStart+m[4], attrsStart+m[5]

			if attrName == "style" {
				raw, s, e := unquote(value, start, end)
				if replaced := rewriteCSS(html.UnescapeString(raw), visit); replaced != raw {
					edits = append(edits, replacement{s, e, escapeAttrValue(replaced, quoteOf(value))})
				}
				continue
			}
			if !contains(wanted, attrName) {
				continue
			}
			addAttr(value, start, end, srcsetAttrs[attrName])
		}
	}

	// Stylesheets written inline reference images of their own.
	for _, block := range styleRe.FindAllStringSubmatchIndex(document, -1) {
		body := document[block[4]:block[5]]
		if replaced := rewriteCSS(body, visit); replaced != body {
			edits = append(edits, replacement{block[4], block[5], replaced})
		}
	}

	return applyReplacements(document, edits)
}

// rewriteCSS is the same walk for stylesheet text, used both for style
// attributes and for whole .css files packed into the archive.
func rewriteCSS(css string, visit func(ref string) string) string {
	var edits []replacement
	for _, m := range cssURL.FindAllStringSubmatchIndex(css, -1) {
		raw, start, end := unquote(css[m[2]:m[3]], m[2], m[3])
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if replaced := visit(trimmed); replaced != trimmed {
			edits = append(edits, replacement{start, end, replaced})
		}
	}
	for _, m := range cssImp.FindAllStringSubmatchIndex(css, -1) {
		raw, start, end := unquote(css[m[2]:m[3]], m[2], m[3])
		trimmed := strings.TrimSpace(raw)
		if replaced := visit(trimmed); replaced != trimmed {
			edits = append(edits, replacement{start, end, replaced})
		}
	}
	return applyReplacements(css, edits)
}

func rewriteSrcset(value string, visit func(ref string) string) string {
	parts := strings.Split(value, ",")
	for i, part := range parts {
		lead := part[:len(part)-len(strings.TrimLeft(part, " \t\r\n"))]
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		url, descriptor := trimmed, ""
		if space := strings.IndexAny(trimmed, " \t"); space != -1 {
			url, descriptor = trimmed[:space], strings.TrimSpace(trimmed[space:])
		}
		decoded := html.UnescapeString(url)
		replaced := visit(decoded)
		if replaced == decoded {
			continue // untouched entries keep their original spelling
		}
		if descriptor != "" {
			replaced += " " + descriptor
		}
		parts[i] = lead + replaced
	}
	return strings.Join(parts, ",")
}

// collectReferences returns every address the document names, in order and
// without repetitions.
func collectReferences(document string) []string {
	var found []string
	seen := map[string]bool{}
	rewriteReferences(document, func(ref string) string {
		if ref != "" && !seen[ref] {
			seen[ref] = true
			found = append(found, ref)
		}
		return ref
	})
	return found
}

// collectCSSReferences does the same for a stylesheet, whose url() entries
// resolve against the stylesheet's own location rather than the document's.
func collectCSSReferences(css string) []string {
	var found []string
	seen := map[string]bool{}
	rewriteCSS(css, func(ref string) string {
		if ref != "" && !seen[ref] {
			seen[ref] = true
			found = append(found, ref)
		}
		return ref
	})
	return found
}

func applyReplacements(source string, edits []replacement) string {
	if len(edits) == 0 {
		return source
	}
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].start < edits[j].start })
	var b strings.Builder
	last := 0
	for _, edit := range edits {
		if edit.start < last {
			continue // overlapping ranges cannot both be written
		}
		b.WriteString(source[last:edit.start])
		b.WriteString(edit.value)
		last = edit.end
	}
	b.WriteString(source[last:])
	return b.String()
}

func unquote(value string, start, end int) (string, int, int) {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[1 : len(value)-1], start + 1, end - 1
	}
	return value, start, end
}

func quoteOf(value string) byte {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[0]
	}
	return 0
}

// escapeAttrValue puts back only what would break the attribute it lands in,
// so an address that was written plainly stays readable in the file.
func escapeAttrValue(value string, quote byte) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	switch quote {
	case '"':
		value = strings.ReplaceAll(value, `"`, "&quot;")
	case '\'':
		value = strings.ReplaceAll(value, "'", "&#39;")
	default:
		value = strings.NewReplacer(`"`, "&quot;", "'", "&#39;", " ", "%20", ">", "&gt;").Replace(value)
	}
	return value
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
