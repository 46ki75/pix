import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";

const phrasingTags = new Set(
  "A ABBR B BDI BDO BR CITE CODE DATA DEL DFN EM I INS KBD MARK Q RP RT RUBY S SAMP SMALL SPAN STRONG SUB SUP TIME U VAR WBR".split(
    " ",
  ),
);
const emphasisTags = new Set(["B", "STRONG", "EM", "I"]);

const converter = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  preformattedCode: true,
  keepReplacement: (_content, node) => `\n\n${literalHtml(node)}\n\n`,
}).use(tables);

// Escape independently of text-node boundaries: adjacent fragments must not create syntax.
// Pipes are escaped by tableCell, after inline conversion, to avoid double escaping.
converter.escape = (text) => text.replace(/[\\`*_{}[\]()#+\-.!<>=~&]/g, "\\$&");

function literalHtml(node: HTMLElement): string {
  // A blank line ends a Markdown HTML block, even inside a table's pre/code content.
  return node.outerHTML.replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
}

function literalInlineHtml(node: Node): string {
  if (node.nodeType === 3) {
    // Inline HTML still permits Markdown in its text. Entities keep punctuation literal.
    return (node.nodeValue ?? "").replace(
      /[!-/:-@[-`{-~\r\n]/g,
      (character) => `&#${character.charCodeAt(0)};`,
    );
  }
  if (node.nodeType !== 1) return "";
  const shell = literalHtml(node.cloneNode(false) as HTMLElement);
  const closing = shell.lastIndexOf("</");
  if (closing < 0) return shell;
  return (
    shell.slice(0, closing) +
    Array.from(node.childNodes, literalInlineHtml).join("") +
    shell.slice(closing)
  );
}

function needsInlineHtml(node: HTMLElement): boolean {
  // Pi's renderer can misparse multi-backtick code spans nested in emphasis or links.
  if (node.nodeName === "CODE")
    return node.childElementCount > 0 || !!node.textContent?.includes("`");
  if (node.nodeName === "A") return node.getElementsByTagName("br").length > 0;
  return (
    emphasisTags.has(node.nodeName) &&
    Array.from(node.getElementsByTagName("*")).some(
      (child) => child.nodeName === "BR" || emphasisTags.has(child.nodeName),
    )
  );
}

function addHtmlRule(name: string, rule: TurndownService.Rule): void {
  // The pinned Turndown patch skips flanking-space extraction for full-node HTML rules.
  const preservingRule = { ...rule, preserveWhitespace: true };
  converter.addRule(name, preservingRule);
}

addHtmlRule("structuredInline", {
  filter: needsInlineHtml,
  // Nested styling/code and explicit emphasis/link breaks can invalidate Markdown delimiters.
  replacement: (_content, node) => literalInlineHtml(node),
});
addHtmlRule("blockLink", {
  filter: (node) =>
    node.nodeName === "A" &&
    Array.from(node.getElementsByTagName("*")).some(
      (child) => !phrasingTags.has(child.nodeName),
    ),
  // A div starts an HTML block even though its outer anchor would otherwise be inline HTML.
  replacement: (_content, node) => `\n\n<div>${literalHtml(node)}</div>\n\n`,
});
converter.addRule("multilineHeading", {
  filter: (node) =>
    /^H[1-6]$/.test(node.nodeName) &&
    node.getElementsByTagName("br").length > 0,
  // ATX headings end at the first newline.
  replacement: (_content, node) => `\n\n${literalHtml(node)}\n\n`,
});
converter.addRule("listBoundary", {
  filter: ["ol", "ul"],
  replacement: (content, node) => {
    const parent = node.parentElement;
    // Following text also needs a closing boundary; lastElementChild ignores that text.
    if (parent?.nodeName === "LI" && parent.lastChild === node)
      return `\n${content}`;
    // Blank lines alone do not separate Markdown lists, including lists in different wrappers.
    return `\n\n${content}\n\n<!-- -->\n\n`;
  },
});
converter.addRule("complexOrderedList", {
  filter: (node) => {
    if (node.nodeName !== "OL") return false;
    const start = node.getAttribute("start") ?? "1";
    const type = node.getAttribute("type");
    return (
      node.hasAttribute("reversed") ||
      (type !== null && type !== "1") ||
      !/^\d{1,9}$/.test(start) ||
      Number(start) + node.children.length - 1 > 999_999_999 ||
      Array.from(node.children).some((child) => child.hasAttribute("value"))
    );
  },
  // GFM supports only sequential, nonnegative decimal numbering with at most nine digits.
  replacement: (_content, node) => `\n\n${literalHtml(node)}\n\n`,
});

// The GFM plugin assumes a first row exists and does not escape cell separators.
converter.addRule("rowlessTable", {
  filter: (node) =>
    node.nodeName === "TABLE" && !(node as HTMLTableElement).rows.length,
  replacement: (content) => `\n\n${content}\n\n`,
});
converter.addRule("tableCell", {
  filter: ["td", "th"],
  replacement: (content, node) => {
    const prefix = node.previousElementSibling ? " " : "| ";
    const cell = content
      .trim()
      .replace(/\|/g, "\\|")
      // Consume whitespace runs even without a following newline to avoid quadratic backtracking.
      .replace(/[ \t]+|\n+/g, (run, offset, text) => {
        if (run[0] === "\n") return "<br>";
        return text[offset + run.length] === "\n" ? "" : run;
      });
    return `${prefix}${cell} |`;
  },
});
const tableHeaders = new WeakSet<HTMLElement>();
converter.addRule("tableRow", {
  filter: "tr",
  replacement: (content, node) => {
    if (!tableHeaders.has(node)) return `\n${content}`;
    // Build the separator in one pass; the plugin rescans siblings for every header cell.
    const borders = Array.from(node.children, (cell) => {
      switch (cell.getAttribute("align")?.toLowerCase()) {
        case "left":
          return ":--";
        case "right":
          return "--:";
        case "center":
          return ":-:";
        default:
          return "---";
      }
    });
    return `\n${content}${borders.length ? `\n| ${borders.join(" | ")} |` : ""}`;
  },
});

// GFM cells support phrasing content only. Unknown/block elements stay in HTML.
const simpleTableTags = new Set([
  ...phrasingTags,
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "TH",
  "TD",
]);
// Keep table structures and code that the GFM plugin cannot represent faithfully.
converter.addRule("complexTable", {
  filter: (node) => {
    if (node.nodeName !== "TABLE") return false;
    const rows = Array.from((node as HTMLTableElement).rows);
    const header = rows[0];
    if (!header) return false;
    tableHeaders.add(header);
    // Domino's row.cells getter uses a quadratic selector union on wide headers.
    const columns = header.children.length;
    let headingRows = 0;
    return (
      // One traversal also avoids quadratic deduplication in selector unions.
      Array.from(node.getElementsByTagName("*")).some(
        (child) =>
          !simpleTableTags.has(child.nodeName) ||
          child.hasAttribute("colspan") ||
          child.hasAttribute("rowspan") ||
          (child.nodeName === "TR" &&
            child.parentElement?.nodeName === "THEAD" &&
            ++headingRows > 1) ||
          needsInlineHtml(child as HTMLElement) ||
          (child.nodeName === "CODE" && !!child.textContent?.includes("\\|")),
      ) ||
      // GFM drops extra cells and pads missing ones to match the header width.
      rows.some((row) => row.children.length !== columns)
    );
  },
  replacement: (_content, node) => `\n\n${literalHtml(node)}\n\n`,
});
converter.addRule("preformatted", {
  filter: "pre",
  replacement: (_content, node) => {
    // Turndown uses a cloned DOM; preserve explicit breaks before reading raw code text.
    for (const br of Array.from(node.querySelectorAll("br"))) {
      br.parentNode?.replaceChild(node.ownerDocument.createTextNode("\n"), br);
    }
    const text = (node.textContent ?? "").replace(/\n$/, "");
    const code = node.firstElementChild;
    const language =
      code?.nodeName === "CODE"
        ? (/(?:^|\s)language-([\w+-]+)/.exec(
            code.getAttribute("class") ?? "",
          )?.[1] ?? "")
        : "";
    let length = 3;
    for (const match of text.matchAll(/`{3,}/g))
      length = Math.max(length, match[0].length + 1);
    const fence = "`".repeat(length);
    return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
  },
});

export function toMarkdown(html: string): string {
  return converter.turndown(html);
}
