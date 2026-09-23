import { expect, test } from "vitest";
import { extractText } from "./extract.ts";
import type { FetchedPage } from "./fetch.ts";

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
});
