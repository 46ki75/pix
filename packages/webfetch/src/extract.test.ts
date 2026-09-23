import { expect, test } from "vitest";
import { extractContent } from "./extract.ts";
import type { FetchedPage } from "./fetch.ts";
import { MAX_CONVERSION_BYTES, MAX_HTML_ATTRIBUTES } from "./html.ts";

const extractText = (page: FetchedPage) => extractContent(page, "text");

function html(text: string): FetchedPage {
  return {
    url: "https://example.com/docs/start",
    contentType: "text/html",
    text,
    responseBytes: Buffer.byteLength(text),
  };
}

test("extracts readable HTML with entities, headings, lists, code, and absolute links", () => {
  const text = extractText(
    html(`<!doctype html><html><head><title>Page title</title></head><body>
    <h1>Guide &amp; reference</h1>
    <p>Read <a href="../next">next</a> and <a href="/root">root</a>.</p>
    <ul><li>First item</li><li>Second item</li></ul>
    <pre>const x = 1;\n  nested();</pre>
  </body></html>`),
  );
  expect(text).toContain("Guide & reference");
  expect(text).toContain("next [https://example.com/next]");
  expect(text).toContain("root [https://example.com/root]");
  expect(text).toContain("* First item");
  expect(text).toContain("* Second item");
  expect(text).toContain("const x = 1;\n  nested();");
  expect(text).not.toContain("<");
});

test("omits scripts, styles, navigation, forms, hidden elements, and embedded resources", () => {
  const text = extractText(
    html(`<body>
    <script>scriptSecret()</script><style>.styleSecret {}</style>
    <nav>navSecret</nav><footer>footerSecret</footer><form>formSecret</form>
    <template>templateSecret</template><div hidden>hiddenSecret</div>
    <div aria-hidden="true">ariaSecret</div><iframe src="https://example.com/embed">iframeSecret</iframe>
    <img src="https://example.com/image"><p>Useful text</p>
  </body>`),
  );
  expect(text).toBe("Useful text");
});

test("keeps table cells and rows distinguishable", () => {
  const text = extractText(
    html(
      "<table><tr><th>Name</th><th>Value</th></tr><tr><td>Version</td><td>1.0</td></tr></table>",
    ),
  );
  expect(text).toContain("Name | Value |");
  expect(text).toContain("\nVersion | 1.0 |");
});

test("handles HTML fragments, malformed markup, and XHTML", () => {
  const page = html("<p>Hello <b>world &amp; friends");
  expect(extractText(page)).toBe("Hello world & friends");
  expect(extractText({ ...page, contentType: "application/xhtml+xml" })).toBe(
    "Hello world & friends",
  );
});

test("regression: preserves literal ampersands in textarea text", () => {
  const page = html("<textarea>echo one && echo two</textarea>");
  expect(extractContent(page)).toBe("echo one \\&\\& echo two");
  expect(extractText(page)).toBe("echo one && echo two");
});

test("regression: preserves escaped noscript markup as literal text", () => {
  const page = html(
    "<noscript>&lt;strong&gt;Visible example&lt;/strong&gt;</noscript>",
  );
  expect(extractText(page)).toBe("<strong>Visible example</strong>");
  expect(extractContent(page)).toBe("\\<strong\\>Visible example\\</strong\\>");
});

test("decodes textarea entities once without interpreting literal markup", () => {
  const page = html(
    '<textarea>&lt;img src="/literal"&gt; &amp;lt;div&amp;gt; &amp;&amp;</textarea>',
  );
  expect(extractText(page)).toBe('<img src="/literal"> &lt;div&gt; &&');
  expect(extractContent(page)).toBe(
    '\\<img src\\="/literal"\\> \\&lt;div\\&gt; \\&\\&',
  );
});

test("filters actual noscript elements and resolves links while keeping escaped markup literal", () => {
  const page = html(
    '<noscript><p>Read <a href="next">docs</a> &lt;img src="/literal"&gt;</p><script>secret()</script><img src="/omitted"></noscript>',
  );
  expect(extractText(page)).toBe(
    'Read docs [https://example.com/docs/next] <img src="/literal">',
  );
  expect(extractContent(page)).toBe(
    'Read [docs](https://example.com/docs/next) \\<img src\\="/literal"\\>',
  );
});

test("keeps link labels when targets are invalid or use unsupported schemes", () => {
  const text = extractText(
    html(
      '<p><a href="javascript:alert(1)">Action</a> <a href="http://[bad">Broken</a></p>',
    ),
  );
  expect(text).toBe("Action Broken");
});

test("bounds traversal of deeply nested HTML and marks the omission", () => {
  const text = extractText(
    html(`${"<div>".repeat(300)}inner${"</div>".repeat(300)}`),
  );
  expect(text).toContain("Deeply nested HTML omitted");
});

test.each([
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
])("preserves %s verbatim", (contentType) => {
  const text = '  <sample>value</sample>\n  {"key":"value"}\n';
  expect(extractText({ ...html(text), contentType })).toBe(text);
  expect(extractContent({ ...html(text), contentType })).toBe(text);
});

test("defaults to Markdown with headings, nested lists, blockquotes, and final-URL links", () => {
  const page = html(`<h1>Guide &amp; reference 🌐</h1>
    <p>Use <code>npm install</code> then <a href="../next?q=1&amp;lang=en">continue</a>.</p>
    <ol><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol>
    <blockquote><p>Remember this.</p></blockquote>`);
  const result = extractContent(page);
  expect(result).toContain("# Guide \\& reference 🌐");
  expect(result).toContain("`npm install`");
  expect(result).toContain(
    "[continue](https://example.com/next?q=1&amp;lang=en)",
  );
  expect(result).toMatch(/1\. +First\n +\- +Nested\n2\. +Second/);
  expect(result).toContain("> Remember this\\.");
});

test("fences bare pre blocks and protects embedded fences while retaining language and whitespace", () => {
  expect(extractContent(html("<pre>const x = 1;\n  next();</pre>"))).toBe(
    "```\nconst x = 1;\n  next();\n```",
  );
  expect(
    extractContent(
      html(
        '<pre><code class="language-js">const x = `test`;\n```\n  next();</code></pre>',
      ),
    ),
  ).toBe("````js\nconst x = `test`;\n```\n  next();\n````");
});

test("regression: preserves br line breaks inside Markdown code blocks", () => {
  const page = html("<pre>echo one<br>echo two</pre>");
  expect(extractContent(page, "text")).toBe("echo one\necho two");
  expect(extractContent(page)).toBe("```\necho one\necho two\n```");
  expect(
    extractContent(
      html(
        '<pre><code class="language-sh"><span>echo &lt;br&gt;</span><br><br>  echo two</code></pre>',
      ),
    ),
  ).toBe("```sh\necho <br>\n\n  echo two\n```");
});

test("converts Markdown tables with escaped pipes, code, and multiline cells", () => {
  const result = extractContent(
    html(`<table>
    <tr><th>Name</th><th>Value</th></tr>
    <tr><td>A | B</td><td><code>x|y</code><br>next</td></tr>
  </table>`),
  );
  expect(result).toContain("| Name | Value |\n| --- | --- |");
  expect(result).toContain("| A \\| B | `x\\|y`<br>next |");
});

test.each([
  ["bare pre", "<pre>echo one\necho two</pre>"],
  [
    "language-tagged code",
    '<pre><code class="language-sh">echo one\necho two</code></pre>',
  ],
  [
    "explicit br",
    '<pre><code class="language-sh">echo one<br>echo two</code></pre>',
  ],
])(
  "regression: preserves code line breaks inside table cells (%s)",
  (_name, code) => {
    const page = html(
      `<table><tr><th>Commands</th></tr><tr><td>${code}</td></tr></table>`,
    );
    expect(extractText(page)).toContain("echo one\necho two");
    const result = extractContent(page);
    expect(result).toContain("echo one&#10;echo two");
    expect(result).toContain("<table>");
    expect(result).toContain("<pre>");
    if (code.includes('class="language-sh"'))
      expect(result).toContain('<code class="language-sh">');
  },
);

test("handles empty tables and preserves headerless and merged-cell tables as HTML", () => {
  expect(extractContent(html("<table></table><p>Useful</p>"))).toBe("Useful");
  expect(
    extractContent(html("<table><tr><td>Name</td><td>Value</td></tr></table>")),
  ).toContain("<td>Name</td><td>Value</td>");
  expect(
    extractContent(
      html(
        '<table><tr><th>Name</th><th>Value</th></tr><tr><td colspan="2">Combined</td></tr></table>',
      ),
    ),
  ).toContain('<td colspan="2">Combined</td>');
});

test("regression: preserves captions in tables without rows", () => {
  const page = html("<table><caption>No records matched</caption></table>");
  expect(extractContent(page, "text")).toBe("No records matched");
  expect(extractContent(page)).toContain("No records matched");
  expect(extractContent(html(`<p>Before</p>${page.text}<p>After</p>`))).toBe(
    "Before\n\nNo records matched\n\nAfter",
  );
});

test.each(["markdown", "text"] as const)(
  "applies content omission and link validation in %s mode",
  (format) => {
    const result = extractContent(
      html(`<body><script>secret()</script><style>secret</style>
    <nav>secret</nav><footer>secret</footer><form>secret</form><template>secret</template>
    <h1 hidden>secret</h1><a href="/secret" aria-hidden="true">secret</a>
    <img src="/secret"><svg>secret</svg><canvas>secret</canvas><iframe>secret</iframe>
    <p><a href="javascript:alert(1)">Action</a> <a href="http://[bad">Broken</a></p></body>`),
      format,
    );
    expect(result).toBe("Action Broken");
  },
);

test("converts malformed markup and XHTML into Markdown", () => {
  const page = {
    ...html("<h1>Title</h1><p>Hello <b>world &amp; friends"),
    contentType: "application/xhtml+xml",
  };
  expect(extractContent(page)).toBe("# Title\n\nHello **world \\& friends**");
});

test.each(["markdown", "text"] as const)(
  "bounds deeply nested HTML before %s conversion",
  (format) => {
    const text = `${"<div>".repeat(10_000)}inner${"</div>".repeat(10_000)}<p>After</p>`;
    const result = extractContent(html(text), format);
    expect(result).toContain("Deeply nested HTML omitted");
    expect(result).toContain("After");
  },
);

test("bounds conversion expansion from repeated links against a long base URL", () => {
  const page = {
    ...html('<a href="x">Link</a>'.repeat(1_000)),
    url: `https://example.com/${"a".repeat(8_000)}/page`,
  };
  expect(() => extractContent(page)).toThrow(
    `converted content exceeded ${MAX_CONVERSION_BYTES} bytes`,
  );
});

test.each(["markdown", "text"] as const)(
  "bounds attributes on retained HTML elements before %s conversion",
  (format) => {
    const attributes = Array.from(
      { length: MAX_HTML_ATTRIBUTES },
      (_, index) => `a${index}="x"`,
    ).join(" ");
    expect(extractContent(html(`<p ${attributes}>Visible</p>`), format)).toBe(
      "Visible",
    );
    expect(() =>
      extractContent(html(`<p ${attributes} extra="x">Visible</p>`), format),
    ).toThrow(`HTML element exceeded ${MAX_HTML_ATTRIBUTES} attributes`);
    expect(
      extractContent(
        html(`<p ${attributes} hidden>Omitted</p><p>Visible</p>`),
        format,
      ),
    ).toBe("Visible");
  },
);
