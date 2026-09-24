import {
  ConversionWriter,
  type HtmlDocument,
  type HtmlElement,
  type HtmlNode,
  isElement,
  prepareDocument,
  serializeHtml,
} from "./html.ts";

const phrasingTags = new Set(
  "a abbr b bdi bdo br cite code data del dfn em i ins kbd mark q rp rt ruby s samp small span strong sub sup time u var wbr".split(
    " ",
  ),
);
const emphasisTags = new Set(["b", "strong", "em", "i"]);
const blockTags = new Set(
  "address article aside blockquote body caption center dd details dialog dir div dl dt fieldset figcaption figure h1 h2 h3 h4 h5 h6 header hgroup hr html legend li main menu ol p pre section summary table tbody td tfoot th thead tr ul".split(
    " ",
  ),
);
const tableTags = new Set([
  ...phrasingTags,
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
]);

function trimLines(text: string): string {
  let start = 0;
  let end = text.length;
  while (text[start] === "\n") start++;
  while (end > start && text[end - 1] === "\n") end--;
  return text.slice(start, end);
}

// Newline separators are pending until content arrives; accumulated output is never rescanned.
class MarkdownWriter {
  private readonly writer = new ConversionWriter();
  private newlines = 0;
  private last = "";

  append(text: string): void {
    if (!text) return;
    const body = trimLines(text);
    let leading = 0;
    while (text[leading] === "\n") leading++;
    this.newlines = Math.min(2, Math.max(this.newlines, leading));
    if (!body) return;
    if (this.newlines) this.writer.append("\n".repeat(this.newlines));
    else if (
      this.last &&
      !/\s/.test(this.last) &&
      !/^\s/.test(body) &&
      (/[*_`]/.test(this.last) || /^[*_`]/.test(body))
    ) {
      // Separate generated delimiters without changing the visible text or introducing spaces.
      this.writer.append("<!-- -->");
    }
    this.writer.append(body);
    this.last = body.at(-1) ?? "";
    this.newlines = Math.min(2, text.length - leading - body.length);
  }

  toString(): string {
    this.writer.append("\n".repeat(this.newlines));
    return this.writer.toString();
  }
}

function normalizeWhitespace(document: HtmlDocument): void {
  let previous: Extract<HtmlNode, { type: "text" }> | undefined;
  let boundary = true;
  const breakFlow = () => {
    if (previous?.data.endsWith(" "))
      previous.data = previous.data.slice(0, -1);
    previous = undefined;
    boundary = true;
  };
  function visit(node: HtmlNode): void {
    if (node.type === "text") {
      node.data = node.data.replace(/[ \t\r\n\f]+/g, " ");
      if (boundary && node.data.startsWith(" ")) node.data = node.data.slice(1);
      if (node.data) {
        previous = node;
        boundary = node.data.endsWith(" ");
      }
    } else if (isElement(node)) {
      const block = blockTags.has(node.name);
      if (block || node.name === "br") breakFlow();
      if (node.name === "pre" || node.name === "code") {
        // Internal code spaces are opaque to the surrounding inline whitespace flow.
        previous = undefined;
        boundary = false;
      } else {
        for (const child of node.children) visit(child);
      }
      if (block) breakFlow();
    }
  }
  for (const node of document.children) visit(node);
  breakFlow();
}

function textContent(node: HtmlNode): string {
  const writer = new ConversionWriter();
  function visit(child: HtmlNode): void {
    if (child.type === "text") writer.append(child.data);
    else if (isElement(child)) {
      if (child.name === "br") writer.append("\n");
      else for (const descendant of child.children) visit(descendant);
    }
  }
  visit(node);
  return writer.toString();
}

interface Structure {
  cells: boolean;
  breaks: boolean;
  emphasis: boolean;
  nonPhrasing: boolean;
  inlineHtml: boolean;
  complexTable: boolean;
}

// Cache subtree facts in one postorder pass, rather than querying descendants for each rule.
function analyze(document: HtmlDocument): WeakMap<HtmlElement, Structure> {
  const structures = new WeakMap<HtmlElement, Structure>();
  function visit(node: HtmlElement): Structure {
    let cells = node.name === "td" || node.name === "th";
    let breaks = false;
    let emphasis = false;
    let nonPhrasing = false;
    let complexTable = false;
    for (const child of node.children) {
      if (!isElement(child)) continue;
      const info = visit(child);
      cells ||= info.cells;
      breaks ||= child.name === "br" || info.breaks;
      emphasis ||= emphasisTags.has(child.name) || info.emphasis;
      nonPhrasing ||= !phrasingTags.has(child.name) || info.nonPhrasing;
      complexTable ||= info.complexTable;
    }
    const code = node.name === "code" ? textContent(node) : "";
    const inlineHtml =
      node.name === "code"
        ? node.children.some(isElement) || code.includes("`")
        : node.name === "a"
          ? breaks
          : emphasisTags.has(node.name) && (breaks || emphasis);
    const info = {
      cells,
      breaks,
      emphasis,
      nonPhrasing,
      inlineHtml,
      complexTable:
        complexTable ||
        !tableTags.has(node.name) ||
        "colspan" in node.attribs ||
        "rowspan" in node.attribs ||
        inlineHtml ||
        (node.name === "code" && code.includes("\\|")),
    };
    structures.set(node, info);
    return info;
  }
  for (const node of document.children) if (isElement(node)) visit(node);
  return structures;
}

function escapeText(text: string): string {
  // Escaping each text node independently also protects punctuation split across inline nodes.
  return text.replace(/[\\`*_{}[\]()#+\-.!<>=~&]/g, "\\$&");
}

function decorate(
  content: string,
  before: string,
  after = before,
  keepEmpty = false,
): string {
  const middle = content.trim();
  if (!middle) return keepEmpty ? content + before + after : content;
  const start = content.length - content.trimStart().length;
  return (
    content.slice(0, start) +
    before +
    middle +
    after +
    content.slice(start + middle.length)
  );
}

function block(content: string): string {
  // Empty blocks still interrupt surrounding text after whitespace normalization.
  return `\n\n${trimLines(content)}\n\n`;
}

export function toMarkdown(input: HtmlDocument | string): string {
  // The string entry point is useful for isolated conversion probes; fetch passes its cleaned tree.
  const document =
    typeof input === "string"
      ? prepareDocument(input, "https://example.invalid/")
      : input;
  normalizeWhitespace(document);
  const structures = analyze(document);

  function children(node: HtmlDocument | HtmlElement): string {
    const writer = new MarkdownWriter();
    for (const child of node.children) writer.append(render(child));
    return writer.toString();
  }

  function list(node: HtmlElement): string {
    const items = node.children.filter(isElement);
    const start = node.attribs.start ?? "1";
    if (
      items.some((item) => item.name !== "li") ||
      node.children.some(
        (child) => child.type === "text" && child.data.trim(),
      ) ||
      (node.name === "ol" &&
        ("reversed" in node.attribs ||
          (node.attribs.type !== undefined && node.attribs.type !== "1") ||
          !/^\d{1,9}$/.test(start) ||
          Number(start) + items.length - 1 > 999_999_999 ||
          items.some((item) => "value" in item.attribs)))
    )
      return block(serializeHtml(node, "block"));
    const writer = new ConversionWriter();
    for (const [index, item] of items.entries()) {
      const prefix = node.name === "ol" ? `${Number(start) + index}.  ` : "- ";
      const content = trimLines(children(item));
      if (index) writer.append("\n");
      writer.append(prefix);
      writer.append(content.replace(/\n/g, `\n${" ".repeat(prefix.length)}`));
    }
    const content = writer.toString();
    if (!content) return block("");
    const parent = node.parent;
    if (parent && isElement(parent) && parent.name === "li" && !node.next)
      return `\n${content}`;
    // Blank lines do not distinguish consecutive lists or text following a nested list.
    return block(`${content}\n\n<!-- -->`);
  }

  function table(node: HtmlElement): string {
    const rows: HtmlElement[] = [];
    let complex = false;
    let headingRows = 0;
    for (const child of node.children) {
      if (!isElement(child)) {
        complex ||= child.type === "text" && !!child.data.trim();
        continue;
      }
      if (child.name === "tr") rows.push(child);
      else if (["thead", "tbody", "tfoot"].includes(child.name)) {
        for (const row of child.children) {
          if (isElement(row) && row.name === "tr") {
            rows.push(row);
            if (child.name === "thead") headingRows++;
          } else if (isElement(row) || (row.type === "text" && row.data.trim()))
            complex = true;
        }
      } else complex = true;
      complex ||= structures.get(child)?.complexTable ?? false;
    }
    // Keep implicit-row cells as HTML; caption-only/empty tables have no grid to retain.
    if (!rows.length)
      return block(
        structures.get(node)?.cells
          ? serializeHtml(node, "block")
          : children(node),
      );
    const cells = rows.map((row) => row.children.filter(isElement));
    const header = cells[0] ?? [];
    const first = rows[0];
    if (
      complex ||
      headingRows > 1 ||
      !header.length ||
      (!(
        first?.parent &&
        isElement(first.parent) &&
        first.parent.name === "thead"
      ) &&
        !header.every((cell) => cell.name === "th")) ||
      cells.some(
        (row) =>
          row.length !== header.length ||
          row.some((cell) => !["td", "th"].includes(cell.name)),
      ) ||
      rows.some((row) =>
        row.children.some(
          (child) => child.type === "text" && child.data.trim(),
        ),
      )
    )
      return block(serializeHtml(node, "block"));
    const writer = new ConversionWriter();
    for (const [index, row] of cells.entries()) {
      if (index) writer.append("\n");
      writer.append("|");
      for (const cell of row) {
        const content = children(cell)
          .trim()
          .replace(/\|/g, "\\|")
          .replace(/[ \t]+|\n+/g, (run, offset, text) =>
            run[0] === "\n"
              ? "<br>"
              : text[offset + run.length] === "\n"
                ? ""
                : run,
          );
        writer.append(` ${content} |`);
      }
      if (index === 0) {
        writer.append("\n|");
        for (const cell of header) {
          const align = cell.attribs.align?.toLowerCase();
          writer.append(
            ` ${align === "left" ? ":--" : align === "right" ? "--:" : align === "center" ? ":-:" : "---"} |`,
          );
        }
      }
    }
    return block(writer.toString());
  }

  function render(node: HtmlNode): string {
    if (node.type === "text") return escapeText(node.data);
    if (!isElement(node)) return "";
    const info = structures.get(node);
    // Malformed markup can nest blocks in emphasis; Markdown delimiters cannot
    // cross those blocks. The div keeps Markdown inactive throughout the fallback.
    if ((node.name === "a" || emphasisTags.has(node.name)) && info?.nonPhrasing)
      return block(`<div>${serializeHtml(node, "block")}</div>`);
    if (info?.inlineHtml) return serializeHtml(node, "inline");
    if (/^h[1-6]$/.test(node.name) && (info?.breaks || info?.nonPhrasing))
      return block(serializeHtml(node, "block"));
    switch (node.name) {
      case "pre": {
        const text = textContent(node).replace(/\n$/, "");
        let length = 3;
        for (const match of text.matchAll(/`{3,}/g))
          length = Math.max(length, match[0].length + 1);
        const code = node.children.find(isElement);
        const language =
          code?.name === "code"
            ? (/(?:^|\s)language-([\w+-]+)/.exec(
                code.attribs.class ?? "",
              )?.[1] ?? "")
            : "";
        const fence = "`".repeat(length);
        return block(`${fence}${language}\n${text}\n${fence}`);
      }
      case "code": {
        const text = textContent(node).replace(/\r\n?|\n/g, " ");
        if (!text) return "";
        const padding =
          text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text)
            ? " "
            : "";
        return `\`${padding}${text}${padding}\``;
      }
      case "br":
        return "  \n";
      case "hr":
        return block("* * *");
      case "ol":
      case "ul":
      case "menu":
      case "dir":
        return list(node);
      case "table":
        return table(node);
    }
    const content = children(node);
    if (node.name === "a" && node.attribs.href !== undefined) {
      let href = node.attribs.href
        .replace(/([\\<>()])/g, "\\$1")
        .replace(/&/g, "&amp;");
      if (href.includes(" ")) href = `<${href}>`;
      const title = node.attribs.title
        ?.replace(/([\\"])/g, "\\$1")
        .replace(/&/g, "&amp;")
        .replace(/\r/g, "&#13;")
        .replace(/\n/g, "&#10;")
        .replace(/\t/g, "&#9;");
      // Even an empty label carries a source URL (for example after omitting an image).
      return decorate(
        content,
        "[",
        `](${href}${title ? ` "${title}"` : ""})`,
        true,
      );
    }
    if (emphasisTags.has(node.name))
      return decorate(
        content,
        ["b", "strong"].includes(node.name) ? "**" : "_",
      );
    if (/^h[1-6]$/.test(node.name))
      return block(`${"#".repeat(Number(node.name[1]))} ${trimLines(content)}`);
    if (node.name === "blockquote")
      return block(trimLines(content).replace(/^/gm, "> "));
    if (blockTags.has(node.name)) return block(content);
    return content;
  }

  return trimLines(children(document));
}
