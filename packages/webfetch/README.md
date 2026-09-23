# @ikuma.cloud/pix-webfetch

A native [Pi Coding Agent](https://pi.dev/) `webfetch` tool for reading a known
HTTP(S) URL. Static HTML becomes readable text with source links; other text
formats retain their original formatting.

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
webfetch({ url: string })
```

The result includes the final URL, content type, and readable text. Pi's
structured `details` contains `url`, `contentType`, `responseBytes`, and
`truncated`. `truncated` indicates that the model-facing output hit its byte
limit; the full body is not duplicated in `details`.

### Supported content

- HTML and XHTML are converted using
  [`html-to-text`](https://github.com/html-to-text/node-html-to-text).
  Headings, lists, code blocks, and table-cell separators are retained.
- Relative links are resolved against the final response URL. Scripts, styles,
  navigation, footers, forms, explicitly hidden elements, and embedded resources
  are omitted.
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
| Model-facing output | 24 KiB, including metadata and any truncation notice |
| HTML traversal depth | 100; deeper content is replaced by an omission marker |

Oversized responses fail rather than being partially parsed. Output truncation
preserves UTF-8 characters and adds an explicit notice. HTTP errors, unsupported
encodings, and network failures are reported through Pi's tool-error mechanism.
Cancellation stops the active request/body read and further redirects.

## Development

```sh
mise run test --project pix-webfetch
mise run check
```

Tests cover HTTP contracts, redirects, cancellation, timeouts, character
decoding, content extraction, and output limits. A local HTTP server checks
native fetch's decompression behavior. Pi-loader integration tests exercise
the package alone and alongside websearch, without model calls or external
network access.
