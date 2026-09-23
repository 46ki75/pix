# @ikuma.cloud/pix-webfetch

A native [Pi Coding Agent](https://pi.dev/) `webfetch` tool for reading a known
HTTP(S) URL. Static HTML becomes Markdown by default, with a readable-text
option. Other text formats retain their original formatting. Large results
include a preview and a path to the full converted output.

Contributors must read [CONTRIBUTING.md](../../CONTRIBUTING.md) before making changes.

## Run locally

Follow the [workspace setup](../../README.md#setup), then run:

```sh
mise run webfetch:dev
```

Ask Pi to read a page, for example:

```text
Fetch https://www.typescriptlang.org/docs/ and summarize the available guides.
```

To load the package in an existing Pi installation:

```sh
pi -e /absolute/path/to/pix/packages/webfetch
```

Pi loads the TypeScript source directly. No build step or API key is required.
The package is private while under development, following the workspace's
new-package convention.

### Use with web search

[`@ikuma.cloud/pix-websearch`](../websearch/README.md) discovers source URLs;
`@ikuma.cloud/pix-webfetch` reads individual sources. Each package registers its
own tool, owns its runtime dependencies, and can be installed and versioned
independently.

To launch Pi with both packages from this workspace:

```sh
mise run web:dev
```

For an existing Pi installation, supply both package paths with separate `-e`
arguments.

## Tool contract

```ts
webfetch({ url: "https://example.com/docs" }) // Markdown by default
webfetch({ url: "https://example.com/docs", format: "text" })
```

`format` accepts `"markdown"` or `"text"` and controls HTML/XHTML conversion.
Existing URL-only calls now return Markdown for HTML pages; use `format: "text"`
for the previous readable-text behavior. Other supported text resources,
including server-provided Markdown, pass through in either mode.

The result includes the final URL, original response content type, and converted
content. Pi's structured `details` contains `url`, `contentType`, `responseBytes`
(decompressed bytes), `truncated`, and, when shortened, `fullOutputPath`.

### Recovering full output

When the model-facing preview exceeds 24 KiB, webfetch saves the complete
conversion result with source metadata to a temporary `.md` or `.txt` file.
The preview includes its absolute path and instructions to continue with Pi's
`read` tool, using `offset` and `limit` to inspect later sections. The full
content is not duplicated in `details`.

Artifacts live under `pix-webfetch` in the operating system's temporary
directory. Each result gets a unique directory. Creating an artifact triggers
best-effort cleanup of owned artifacts older than seven days; the operating
system may remove temporary files sooner. Failed or canceled writes are cleaned
up, and persistence failures are reported as tool errors.

`truncated` refers specifically to preview shortening. Saved output reflects
the same HTML filtering and depth limit as the preview; it is not the raw page.

### Supported content

- HTML and XHTML are converted to Markdown using
  [Turndown](https://github.com/mixmark-io/turndown) with GFM table support.
  Headings, links, nested lists, blockquotes, inline code, and fenced code blocks
  are retained. Tables remain HTML when they have no header, multiple header
  rows, unequal row widths, merged cells, nested tables, block-level cell content,
  or inline markup requiring HTML preservation. HTML also preserves nested
  emphasis and code, headings with explicit line breaks, links around block
  content, and ordered lists whose numbering GFM cannot represent. Line breaks
  in block HTML and Markdown-active punctuation in inline HTML are entity-encoded
  to preserve literal content.
- Plain-text conversion uses
  [`html-to-text`](https://github.com/html-to-text/node-html-to-text), preserving
  readable headings, lists, code blocks, and table-cell separators.
- Relative links are resolved against the final response URL. Scripts, styles,
  navigation, footers, forms, explicitly hidden elements, and embedded resources
  are omitted through shared preprocessing in both modes. Markdown requests
  prefer server-provided `text/markdown` through the HTTP `Accept` header;
  text-mode requests prefer `text/plain`.
- Plain text, Markdown, JSON, XML, YAML, JavaScript, and other `text/*` types
  are returned as text. JSON/XML-suffixed application types are supported too.
- HTTP `charset` declarations are honored, with UTF-8 as the default.
  A missing content type is treated as plain text.
- Unsupported content types and text containing NUL characters produce an error.

Fetching reads the server's response without executing JavaScript, loading
linked assets, or using browser cookies. Client-rendered pages may therefore
contain little readable text.

### Limits and errors

| Limit | Value |
| --- | --- |
| URL | HTTP(S), no embedded credentials, up to 8,192 serialized bytes |
| Redirects | Five, with loop detection and URL validation at each hop |
| Network deadline | 25 seconds total, including redirects and body reads |
| Response body | 1 MiB of decompressed bytes |
| Prepared HTML / converted HTML output | 4 MiB each, including expansion from resolved links |
| Model-facing output | 24 KiB, including metadata and the full-output notice |
| HTML traversal depth | 100; deeper content is replaced by an omission marker |
| HTML attributes | Up to 256 per retained element; exceeding this fails conversion |

Oversized responses or HTML conversions fail rather than returning a partial
conversion. Preview truncation prefers complete lines, preserves UTF-8 characters
when splitting long lines, and provides a recoverable full-output file.
HTTP errors, unsupported encodings, and network failures are reported through
Pi's tool-error mechanism.
Cancellation stops the active request/body read and further redirects.

## Development

```sh
mise run test --project pix-webfetch
mise run check
```

Tests cover HTTP negotiation, redirects, cancellation, timeouts, character
decoding, Markdown/text extraction, table rendering, conversion performance,
output limits, artifact persistence, and retention. A local HTTP server checks
native fetch's decompression behavior.
Pi-loader integration tests exercise both output formats, loading alongside
websearch, and reading later sections from an overflow artifact through Pi's
real `read` tool, without model calls or external network access.
