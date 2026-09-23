import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { DomUtils, parseDocument } from "htmlparser2";
import { expect, test } from "vitest";
import { extractContent } from "./extract.ts";

// Exercise the renderer shipped with Pi so valid-looking Markdown cannot hide lost cells.
const renderer = {} as { marked: { parse(markdown: string): string } };
runInNewContext(
  await readFile(
    new URL(
      "./core/export-html/vendor/marked.min.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ),
    "utf8",
  ),
  renderer,
);

function renderHtml(text: string) {
  const markdown = extractContent({
    url: "https://example.com/",
    contentType: "text/html",
    text,
    responseBytes: Buffer.byteLength(text),
  });
  const document = parseDocument(renderer.marked.parse(markdown));
  return { markdown, document };
}

function renderTable(html: string) {
  const { markdown, document } = renderHtml(html);
  const rows = DomUtils.getElementsByTagName("tr", document).map((row) =>
    row.children
      .filter((node) => "name" in node && ["td", "th"].includes(node.name))
      .map((node) => DomUtils.textContent(node)),
  );
  return { markdown, document, rows };
}

test.each(["a|b", String.raw`a\|b`, String.raw`a\\|b`, String.raw`a\\\|b`])(
  "preserves inline code %s and its neighboring table cell when rendered",
  (code) => {
    const { document, rows } = renderTable(
      `<table><tr><th>Regex</th><th>Name</th></tr><tr><td><code>${code}</code></td><td>Test</td></tr></table>`,
    );
    expect(rows).toEqual([
      ["Regex", "Name"],
      [code, "Test"],
    ]);
    expect(
      DomUtils.getElementsByTagName("code", document).map((node) =>
        DomUtils.textContent(node),
      ),
    ).toEqual([code]);
  },
);

test("preserves multiple header rows without introducing separator data", () => {
  const { document, rows } = renderTable(
    "<table><thead><tr><th>A</th><th>B</th></tr><tr><th>AA</th><th>BB</th></tr></thead><tbody><tr><td>C</td><td>D</td></tr></tbody></table>",
  );
  expect(rows).toEqual([
    ["A", "B"],
    ["AA", "BB"],
    ["C", "D"],
  ]);
  expect(DomUtils.getElementsByTagName("th", document)).toHaveLength(4);
});

test("still converts a single header row to a GFM table", () => {
  const { markdown, rows } = renderTable(
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>C</td><td>D</td></tr></tbody></table>",
  );
  expect(markdown).toContain("| A | B |\n| --- | --- |");
  expect(rows).toEqual([
    ["A", "B"],
    ["C", "D"],
  ]);
});

test.each([
  [
    "wider body row",
    "<tr><th>Name</th></tr><tr><td>A</td><td>Important extra value</td></tr>",
    [["Name"], ["A", "Important extra value"]],
  ],
  [
    "narrower body row",
    "<tr><th>Name</th><th>Value</th></tr><tr><td>A</td></tr>",
    [["Name", "Value"], ["A"]],
  ],
  [
    "wider footer row",
    "<thead><tr><th>Name</th></tr></thead><tbody><tr><td>A</td></tr></tbody><tfoot><tr><td>Total</td><td>Important extra value</td></tr></tfoot>",
    [["Name"], ["A"], ["Total", "Important extra value"]],
  ],
])("preserves every cell in a table with a %s", (_name, content, expected) => {
  const { rows } = renderTable(`<table>${content}</table>`);
  expect(rows).toEqual(expected);
});

test.each([
  "/search?q=&copy;",
  "/search?q=&#65;",
  "/search?q=&amp;",
  "/search?q=&copy",
  String.raw`/search?regex=\*`,
  String.raw`/search?regex=\(`,
  String.raw`/search?regex=\|`,
  "/search?q=example&lang=en",
  "/search?q=%26copy%3B&regex=%5C*",
])("preserves the rendered link destination %s", (href) => {
  const link = `<a href="${href.replace(/&/g, "&amp;")}">Link</a>`;
  for (const html of [
    `<p>${link}</p>`,
    `<table><tr><th>Link</th><th>Note</th></tr><tr><td>${link}</td><td>Test</td></tr></table>`,
  ]) {
    const { document } = renderHtml(html);
    const links = DomUtils.getElementsByTagName("a", document);
    expect(links).toHaveLength(1);
    // Pi percent-encodes backslashes and pipes; reserved URL delimiters must stay intact.
    expect(decodeURI(links[0]?.attribs.href ?? "")).toBe(
      decodeURI(new URL(href, "https://example.com/").href),
    );
    expect(links.map((node) => DomUtils.textContent(node))).toEqual(["Link"]);
    const cells = DomUtils.getElementsByTagName("td", document);
    if (cells.length) {
      expect(cells.map((node) => DomUtils.textContent(node))).toEqual([
        "Link",
        "Test",
      ]);
    }
  }
});

test.each([" x", "x ", " x ", "`x", "x`", "`x`", "a``b`c"])(
  "preserves inline-code whitespace and backticks in %s",
  (code) => {
    const { document } = renderHtml(`<p><code>${code}</code></p>`);
    expect(
      DomUtils.getElementsByTagName("code", document).map((node) =>
        DomUtils.textContent(node),
      ),
    ).toEqual([code]);
  },
);

test.each(["first\n\n**literal**", "first<br><br>**literal**"])(
  "preserves blank lines and Markdown-looking text inside HTML table code: %s",
  (code) => {
    for (const header of ["<tr><th>Code</th></tr>", ""]) {
      const { document } = renderTable(
        `<table>${header}<tr><td><pre>${code}</pre></td></tr></table>`,
      );
      expect(
        DomUtils.getElementsByTagName("pre", document).map((node) =>
          DomUtils.textContent(node),
        ),
      ).toEqual(["first\n\n**literal**"]);
    }
  },
);

test.each([
  String.raw`back\|pipe`,
  String.raw`back\"quote`,
  "&copy;",
  "A\nB",
  "A\n\n B",
])("preserves link titles and neighboring table cells: %s", (title) => {
  const attribute = title.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const { document, rows } = renderTable(
    `<table><tr><th>A</th><th>B</th></tr><tr><td><a href="/" title="${attribute}">Go</a></td><td>Next</td></tr></table>`,
  );
  expect(rows).toEqual([
    ["A", "B"],
    ["Go", "Next"],
  ]);
  expect(
    DomUtils.getElementsByTagName("a", document).map(
      (node) => node.attribs.title,
    ),
  ).toEqual([title]);
});

test.each([
  ["<code>npm <b>install</b></code>", "npm install"],
  ["<code>npm <em>install</em></code>", "npm install"],
  ["<code><span>echo</span> *a*</code>", "echo *a*"],
  ["<code><span>x</span> &amp;copy; `a` [b](c)</code>", "x &copy; `a` [b](c)"],
  ["<code>a</code><code>b</code>", "ab"],
  ["<strong>a</strong><strong>b</strong>", "ab"],
  ["<em>a</em><em>b</em>", "ab"],
  ["<span><code>a</code></span><code>b</code>", "ab"],
  ["non<em>empty</em>word", "nonemptyword"],
  ["<strong>a<strong>!</strong></strong>", "a!"],
  ["<em>a<em>!</em></em>", "a!"],
  ["<b>a<strong>!</strong></b>", "a!"],
])("preserves the visible text of inline markup %s", (html, text) => {
  const { document } = renderHtml(`<p>${html}</p>`);
  expect(
    DomUtils.getElementsByTagName("p", document).map((node) =>
      DomUtils.textContent(node),
    ),
  ).toEqual([text]);
});

test.each(["<h2>Documentation</h2>", "<div>Documentation</div>"])(
  "preserves links around block content %s",
  (content) => {
    const { document } = renderHtml(`<a href="/docs">${content}</a>`);
    const links = DomUtils.getElementsByTagName("a", document);
    expect(
      links.map((node) => [node.attribs.href, DomUtils.textContent(node)]),
    ).toEqual([["https://example.com/docs", "Documentation"]]);
    expect(DomUtils.textContent(document).trim()).toBe("Documentation");
  },
);

test.each(["", ' start="3"'])(
  "keeps adjacent ordered lists separate: %s",
  (start) => {
    const { document } = renderHtml(
      `<ol><li>First procedure</li></ol><ol${start}><li>Second procedure</li></ol>`,
    );
    const lists = DomUtils.getElementsByTagName("ol", document);
    expect(lists).toHaveLength(2);
    expect(lists.map((node) => Number(node.attribs.start ?? 1))).toEqual([
      1,
      start ? 3 : 1,
    ]);
  },
);

test.each(['start="-1"', 'start="1000000000"', "reversed", 'type="a"'])(
  "preserves non-GFM ordered-list numbering and code: %s",
  (attributes) => {
    const html = `<ol ${attributes}><li>Run<pre>echo hi</pre></li><li>Continue</li></ol>`;
    const { document } = renderHtml(html);
    const lists = DomUtils.getElementsByTagName("ol", document);
    expect(lists).toHaveLength(1);
    expect(lists[0]?.attribs).toEqual(
      DomUtils.getElementsByTagName("ol", parseDocument(html))[0]?.attribs,
    );
    expect(
      DomUtils.getElementsByTagName("pre", document).map((node) =>
        DomUtils.textContent(node).trim(),
      ),
    ).toEqual(["echo hi"]);
    expect(DomUtils.getElementsByTagName("li", document)).toHaveLength(2);
  },
);

test("preserves explicit list-item numbers and empty items", () => {
  const { document } = renderHtml(
    '<ol><li></li><li value="5">Five</li><li>Six</li></ol>',
  );
  const items = DomUtils.getElementsByTagName("li", document);
  expect(items).toHaveLength(3);
  expect(items[1]?.attribs.value).toBe("5");
});

test.each(["ol", "ul"])("retains empty items in ordinary %s lists", (tag) => {
  const { document } = renderHtml(`<${tag}><li></li><li>Next</li></${tag}>`);
  expect(
    DomUtils.getElementsByTagName("li", document).map((node) =>
      DomUtils.textContent(node),
    ),
  ).toEqual(["", "Next"]);
});

test.each(["ol", "ul"])(
  "keeps text after a nested %s in its parent item",
  (tag) => {
    for (const tail of ["Tail", " Tail"]) {
      const { document } = renderHtml(
        `<${tag}><li>Outer<${tag}><li>Inner</li></${tag}>${tail}</li></${tag}>`,
      );
      const items = DomUtils.getElementsByTagName("li", document);
      expect(items).toHaveLength(2);
      expect(items[1] && DomUtils.textContent(items[1])).toBe("Inner");
      expect(items[0] && DomUtils.textContent(items[0])).toContain("Tail");
    }
  },
);

test("keeps explicit line breaks inside a single heading", () => {
  const { document } = renderHtml("<h2>API<br>Reference</h2>");
  const headings = DomUtils.getElementsByTagName("h2", document);
  expect(headings).toHaveLength(1);
  expect(headings.map((node) => DomUtils.textContent(node))).toEqual([
    "APIReference",
  ]);
  expect(DomUtils.getElementsByTagName("br", document)).toHaveLength(1);
  expect(DomUtils.getElementsByTagName("p", document)).toHaveLength(0);
});

test.each(["strong", "b", "em", "i"])(
  "preserves emphasis with edge and consecutive breaks in %s",
  (tag) => {
    for (const content of ["a<br>", "<br>a", "a<br><br>b"]) {
      const { document } = renderHtml(`<p><${tag}>${content}</${tag}></p>`);
      const expected = parseDocument(content);
      expect(DomUtils.textContent(document).trim()).toBe(
        DomUtils.textContent(expected),
      );
      expect(DomUtils.getElementsByTagName(tag, document)).toHaveLength(1);
      expect(DomUtils.getElementsByTagName("br", document)).toHaveLength(
        DomUtils.getElementsByTagName("br", expected).length,
      );
    }
  },
);

test.each([
  ["<strong><code>`*</code></strong>", "`*"],
  ["<em><code>`_</code></em>", "`_"],
  ['<a href="/"><code>`</code>y</a>', "`y"],
])("preserves backticks in nested inline code: %s", (html, text) => {
  const { document } = renderHtml(`<p>${html}</p>`);
  expect(DomUtils.textContent(document).trim()).toBe(text);
  expect(DomUtils.getElementsByTagName("code", document)).toHaveLength(1);
  if (html.startsWith("<a")) {
    expect(
      DomUtils.getElementsByTagName("a", document).map((node) => [
        node.attribs.href,
        DomUtils.textContent(node),
      ]),
    ).toEqual([["https://example.com/", text]]);
  }
});

test.each([
  "<strong>&nbsp;<em>x</em></strong>",
  "<strong><em>x</em>&nbsp;</strong>",
  "<strong>&nbsp;a<br>b</strong>",
  "<em>a<br>b&nbsp;</em>",
  '<a href="/">&nbsp;a<br>b&nbsp;</a>',
  '<a href="/"><div>&nbsp;Documentation&nbsp;</div></a>',
  "<span><strong>&nbsp;<em>x</em></strong></span>",
  '<a href="/"><strong>&nbsp;<em>x</em></strong></a>',
])("preserves edge whitespace exactly once in HTML fallback: %s", (html) => {
  const { document } = renderHtml(html);
  expect(DomUtils.textContent(document).replace(/\n/g, "")).toBe(
    DomUtils.textContent(parseDocument(html)),
  );
});

test.each(["span", "em", "a"])(
  "keeps code-internal spaces inside its %s wrapper",
  (tag) => {
    for (const code of [
      "    npm install",
      "npm install    ",
      "    npm install    ",
    ]) {
      const { document } = renderHtml(
        `<p><${tag}${tag === "a" ? ' href="/docs"' : ""}><code>${code}</code></${tag}></p>`,
      );
      expect(DomUtils.getElementsByTagName("pre", document)).toHaveLength(0);
      expect(
        DomUtils.getElementsByTagName("code", document).map((node) =>
          DomUtils.textContent(node),
        ),
      ).toEqual([code]);
      if (tag === "a") {
        expect(
          DomUtils.getElementsByTagName("a", document).map(
            (node) => node.attribs.href,
          ),
        ).toEqual(["https://example.com/docs"]);
      }
    }
  },
);

test.each([
  ["<p>!<a href='/download'>Download</a></p>", "!Download"],
  ["<p><span>&amp;</span>copy;</p>", "&copy;"],
  ["<p>###</p>", "###"],
  ["<h1>API #</h1>", "API #"],
  ["<p>Literal ~~old~~</p>", "Literal ~~old~~"],
  ["<p>1) ordinary text</p>", "1) ordinary text"],
])("preserves literal Markdown punctuation in %s", (html, text) => {
  const { document } = renderHtml(html);
  expect(DomUtils.textContent(document).trim()).toBe(text);
  expect(DomUtils.getElementsByTagName("img", document)).toHaveLength(0);
});

test("preserves printable ASCII across arbitrary inline text-node boundaries", () => {
  const text = Array.from({ length: 94 }, (_, index) =>
    String.fromCharCode(index + 33),
  ).join("");
  const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const content of [
    escapeHtml(text),
    Array.from(
      text,
      (character) => `<span>${escapeHtml(character)}</span>`,
    ).join(""),
  ]) {
    const { document } = renderHtml(`<p>${content}</p>`);
    expect(DomUtils.textContent(document).trim()).toBe(text);
  }
});

test.each([
  ["blockquote", "quoted"],
  ["h2", "Title"],
  ["ul", "<li>First</li><li>Second</li>"],
  ["ol", "<li>First</li><li>Second</li>"],
])("retains %s structure inside table cells", (tag, content) => {
  const { document } = renderTable(
    `<table><tr><th>A</th></tr><tr><td><${tag}>${content}</${tag}></td></tr></table>`,
  );
  const blocks = DomUtils.getElementsByTagName(tag, document);
  expect(blocks).toHaveLength(1);
  expect(blocks.map((node) => DomUtils.textContent(node))).toEqual([
    DomUtils.textContent(parseDocument(content)),
  ]);
});

test.each([" ", "  "])("retains whitespace-only inline code %s", (code) => {
  for (const html of [
    `<p>Delimiter: <code>${code}</code>.</p>`,
    `<p><code>${code}</code></p>`,
  ]) {
    const { document } = renderHtml(html);
    expect(
      DomUtils.getElementsByTagName("code", document).map((node) =>
        DomUtils.textContent(node),
      ),
    ).toEqual([code]);
  }
});

test("converts long whitespace runs in table code within a bounded time", () => {
  // A separate process lets the deadline interrupt synchronous regexp backtracking.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { toMarkdown } from ${JSON.stringify(new URL("./markdown.ts", import.meta.url).href)};
       const code = "a" + " ".repeat(160_000) + "b";
       const html = "<table><tr><th>Code</th></tr><tr><td><code>" + code + "</code></td></tr></table>";
       assert.equal(toMarkdown(html), "| Code |\\n| --- |\\n| \`" + code + "\` |");`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);

test("converts a response-sized ordered list within a bounded time", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { extractContent } from ${JSON.stringify(new URL("./extract.ts", import.meta.url).href)};
       const text = "<ol>" + "<li>x".repeat(200_000) + "</ol>";
       const page = { url: "https://example.com/", contentType: "text/html", text, responseBytes: Buffer.byteLength(text) };
       const markdown = extractContent(page);
       assert.ok(markdown.startsWith("1.  x\\n2.  x\\n"));
       assert.ok(markdown.endsWith("200000.  x\\n\\n<!-- -->"));`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);

test("converts long inline code with a leading space within a bounded time", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { extractContent } from ${JSON.stringify(new URL("./extract.ts", import.meta.url).href)};
       const code = " " + "a".repeat(160_000);
       const text = "<p><code>" + code + "</code></p>";
       const page = { url: "https://example.com/", contentType: "text/html", text, responseBytes: Buffer.byteLength(text) };
       assert.equal(extractContent(page), "\`" + code + "\`");`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);

test("converts a response-sized table header within a bounded time", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { extractContent } from ${JSON.stringify(new URL("./extract.ts", import.meta.url).href)};
       const text = "<table><tr>" + "<th>x".repeat(150_000) + "</tr></table>";
       const page = { url: "https://example.com/", contentType: "text/html", text, responseBytes: Buffer.byteLength(text) };
       const lines = extractContent(page).split("\\n");
       assert.equal(lines.length, 2);
       assert.equal(lines[0].split("|").length, 150_002);
       assert.equal(lines[1].split("|").length, 150_002);`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);

test("converts mixed trailing whitespace in bare pre blocks within a bounded time", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { extractContent } from ${JSON.stringify(new URL("./extract.ts", import.meta.url).href)};
       const spaces = " ".repeat(160_000);
       const fence = String.fromCharCode(96).repeat(3);
       for (const span of [false, true]) {
         const content = "a" + spaces + "&#160;";
         const text = "<pre>" + (span ? "<span>" + content + "</span>" : content) + "</pre>";
         const page = { url: "https://example.com/", contentType: "text/html", text, responseBytes: Buffer.byteLength(text) };
         assert.equal(extractContent(page), fence + "\\na" + spaces + "\\u00a0\\n" + fence);
       }`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);

test("converts mixed whitespace inside code wrappers within a bounded time", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { extractContent } from ${JSON.stringify(new URL("./extract.ts", import.meta.url).href)};
       const spaces = " ".repeat(160_000);
       for (const tag of ["a", "span", "em"]) {
         const text = "<p><" + tag + (tag === "a" ? ' href="/x"' : "") + "><code>a" + spaces + "&#160;</code></" + tag + "></p>";
         const page = { url: "https://example.com/", contentType: "text/html", text, responseBytes: Buffer.byteLength(text) };
         assert.ok(extractContent(page).includes("a" + spaces + "\\u00a0"));
       }`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);

test("rejects excessive HTML attributes before reparsing within a bounded time", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { extractContent } from ${JSON.stringify(new URL("./extract.ts", import.meta.url).href)};
       const text = '<p ' + Array.from({ length: 80_000 }, (_, i) => 'a' + i + '=x').join(' ') + '>Visible</p>';
       const page = { url: "https://example.com/", contentType: "text/html", text, responseBytes: Buffer.byteLength(text) };
       assert.throws(() => extractContent(page), /HTML element exceeded 256 attributes/);`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);
