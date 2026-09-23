import { decodeHTML, escapeAttribute, escapeText } from "entities";
import { DomHandler, parseDocument, Parser } from "htmlparser2";
import { FetchError } from "./fetch.ts";

export const MAX_HTML_DEPTH = 100;
export const MAX_HTML_ATTRIBUTES = 256;
export const MAX_CONVERSION_BYTES = 4 * 1024 * 1024;
export type HtmlDocument = ReturnType<typeof parseDocument>;
export type HtmlNode = HtmlDocument["children"][number];
export type HtmlElement = Extract<HtmlNode, { attribs: unknown }>;

export function isElement(node: HtmlNode): node is HtmlElement {
  return "attribs" in node;
}

// Count before retaining chunks so expansion fails at the same limit in every writer.
export class ConversionWriter {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private readonly collect: boolean;

  constructor(collect = true) {
    this.collect = collect;
  }

  append(text: string): void {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > MAX_CONVERSION_BYTES)
      throw new FetchError(
        `Web fetch converted content exceeded ${MAX_CONVERSION_BYTES} bytes.`,
      );
    if (this.collect && text) this.chunks.push(text);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

const voidTags = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " ",
  ),
);
type HtmlMode = "html" | "block" | "inline";

function encodeLines(text: string): string {
  return text.replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
}

function writeHtml(
  node: HtmlNode | HtmlDocument,
  writer: ConversionWriter,
  mode: HtmlMode,
  pre = false,
): void {
  if (node.type === "text") {
    // Markdown remains active inside inline HTML; encode punctuation as literal text.
    const text =
      mode === "inline"
        ? node.data.replace(
            /[!-/:-@[-`{-~\r\n]/g,
            (char) => `&#${char.charCodeAt(0)};`,
          )
        : escapeText(node.data);
    writer.append(mode === "html" ? text : encodeLines(text));
    return;
  }
  if (node.type === "root") {
    for (const child of node.children) writeHtml(child, writer, mode, pre);
    return;
  }
  if (!isElement(node)) return;
  if (pre && node.name === "br" && mode !== "html") {
    writer.append("&#10;");
    return;
  }
  writer.append(`<${node.name}`);
  for (const [name, value] of Object.entries(node.attribs)) {
    const escaped = escapeAttribute(value);
    writer.append(
      ` ${name}="${mode === "html" ? escaped : encodeLines(escaped)}"`,
    );
  }
  writer.append(">");
  if (voidTags.has(node.name)) return;
  for (const child of node.children)
    writeHtml(child, writer, mode, pre || node.name === "pre");
  writer.append(`</${node.name}>`);
}

export function serializeHtml(
  node: HtmlNode | HtmlDocument,
  mode: HtmlMode = "html",
): string {
  const writer = new ConversionWriter();
  writeHtml(node, writer, mode);
  return writer.toString();
}
const DEPTH_NOTICE = "[Deeply nested HTML omitted.]";
const omittedTags = new Set([
  "head",
  "script",
  "style",
  "template",
  "nav",
  "footer",
  "form",
  "iframe",
  "svg",
  "canvas",
  "img",
]);

export function isHtml(contentType: string): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

function isOmitted(node: HtmlElement): boolean {
  return (
    omittedTags.has(node.name) ||
    "hidden" in node.attribs ||
    node.attribs["aria-hidden"] === "true"
  );
}

export function checkConversionSize(text: string): string {
  if (Buffer.byteLength(text) > MAX_CONVERSION_BYTES) {
    throw new FetchError(
      `Web fetch converted content exceeded ${MAX_CONVERSION_BYTES} bytes.`,
    );
  }
  return text;
}

export function prepareHtml(html: string, url: string): string {
  return serializeHtml(prepareDocument(html, url));
}

// htmlparser2 retains nested anchors, unlike a browser DOM. Close an outer link at
// the next anchor, splitting intervening wrappers so labels never contain links.
function normalizeAnchors(nodes: HtmlNode[]): HtmlNode[] {
  interface Anchor {
    closed: boolean;
  }
  interface Segment {
    node: HtmlNode;
    outside: boolean;
  }
  function visit(node: HtmlNode, anchor?: Anchor): Segment[] {
    if (!isElement(node)) return [{ node, outside: anchor?.closed ?? false }];
    if (node.name === "a") {
      if (anchor) anchor.closed = true;
      const own = { closed: false };
      const segments = node.children.flatMap((child) => visit(child, own));
      node.children = segments
        .filter((segment) => !segment.outside)
        .map((segment) => segment.node);
      return [
        node,
        ...segments
          .filter((segment) => segment.outside)
          .map((segment) => segment.node),
      ].map((child) => ({ node: child, outside: anchor?.closed ?? false }));
    }
    const outside = anchor?.closed ?? false;
    const segments = node.children.flatMap((child) => visit(child, anchor));
    const split = segments.findIndex((segment) => segment.outside !== outside);
    if (split < 0) {
      node.children = segments.map((segment) => segment.node);
      return [{ node, outside }];
    }
    const tail = node.cloneNode(false);
    node.children = segments.slice(0, split).map((segment) => segment.node);
    tail.children = segments.slice(split).map((segment) => segment.node);
    return [
      ...(node.children.length ? [{ node, outside }] : []),
      { node: tail, outside: true },
    ];
  }
  return nodes.flatMap((node) => visit(node).map((segment) => segment.node));
}

// Preserve which source end tag caused implied closes: the resulting tree alone
// cannot distinguish </li> from a wrapper end tag that happened to pop an item.
class SourceHandler extends DomHandler {
  readonly closedBy = new WeakMap<HtmlNode, HtmlElement>();
  readonly explicitCloses = new WeakSet<HtmlNode>();
  private implied: HtmlElement[] = [];

  override onopentag(name: string, attribs: Record<string, string>): void {
    this.implied = [];
    super.onopentag(name, attribs);
  }

  override onclosetag(_name?: string, isImplied = false): void {
    const node = this.tagStack.at(-1);
    if (node && isElement(node)) {
      if (isImplied) {
        if (!voidTags.has(node.name)) this.implied.push(node);
      } else {
        this.explicitCloses.add(node);
        for (const child of this.implied) this.closedBy.set(child, node);
        this.implied = [];
      }
    }
    super.onclosetag();
  }
}

// htmlparser2 only closes an immediately open li. Replay the tree iteratively so
// a new item also closes intervening paragraphs/wrappers, before depth pruning
// can mistake a long list with omitted end tags for deeply nested content.
function normalizeTree(document: HtmlDocument, source: SourceHandler): void {
  const barriers = new Set(
    "applet article aside blockquote button caption center dd details dialog dir dl dt fieldset figcaption figure footer header hgroup main marquee menu nav object ol pre section table tbody td tfoot th thead tr ul".split(
      " ",
    ),
  );
  const pending: { node: HtmlNode | HtmlDocument; exit: boolean }[] = [
    { node: document, exit: false },
  ];
  const open: {
    node: HtmlElement | HtmlDocument;
    item: number;
    previousNamed: HtmlElement | undefined;
  }[] = [];
  const named = new Map<string, HtmlElement>();
  const positions = new WeakMap<HtmlNode | HtmlDocument, number>();
  const position = (node: HtmlNode | HtmlDocument): number => {
    const index = positions.get(node) ?? -1;
    return open[index]?.node === node ? index : -1;
  };
  const close = (index: number) => {
    while (open.length > index) {
      const frame = open.pop();
      if (frame && isElement(frame.node)) {
        if (frame.previousNamed)
          named.set(frame.node.name, frame.previousNamed);
        else named.delete(frame.node.name);
      }
    }
  };
  while (pending.length) {
    const event = pending.pop();
    if (!event) break;
    const { node, exit } = event;
    if (exit) {
      // Once list repair closes a wrapper, its later end tag is stale. Ignore
      // the parser's induced child closes too, or trailing text escapes its item.
      if (isElement(node) && source.explicitCloses.has(node)) {
        const target = named.get(node.name);
        if (target) close(position(target));
        continue;
      }
      const cause = source.closedBy.get(node);
      if (cause && position(cause) < 0) continue;
      const index = position(node);
      if (index >= 0) close(index);
      continue;
    }
    // Drop omitted subtrees before any repair can promote their descendants.
    if (isElement(node) && isOmitted(node)) continue;
    if (isElement(node) && node.name === "pre") {
      // Only a newline immediately after the start tag is ignored. Inspect the
      // original children, before filtering comments or omitted elements.
      const first = node.children[0];
      if (first?.type === "text" && first.data.startsWith("\n"))
        first.data = first.data.slice(1);
    }
    let item = open.at(-1)?.item ?? -1;
    if (isElement(node) && node.name === "li" && item >= 0) {
      close(item);
      item = open.at(-1)?.item ?? -1;
    }
    if (node.type !== "root") open.at(-1)?.node.children.push(node);
    if (node.type === "root" || isElement(node)) {
      if (node.type !== "root") {
        if (barriers.has(node.name)) item = -1;
        else if (node.name === "li") item = open.length;
      }
      positions.set(node, open.length);
      const previousNamed =
        node.type === "root" ? undefined : named.get(node.name);
      if (node.type !== "root") named.set(node.name, node);
      open.push({ node, item, previousNamed });
      pending.push({ node, exit: true });
      for (let index = node.children.length - 1; index >= 0; index--) {
        const child = node.children[index];
        if (child) pending.push({ node: child, exit: false });
      }
      node.children = [];
    }
  }
}

export function prepareDocument(html: string, url: string): HtmlDocument {
  // Match HTML input-stream newline normalization without needing a second DOM parser.
  const handler = new SourceHandler();
  new Parser(handler).end(html.replace(/\r\n?/g, "\n"));
  const document = handler.root;
  normalizeTree(document, handler);
  let linkBytes = 0;

  function clean(
    nodes: typeof document.children,
    depth: number,
  ): typeof document.children {
    return nodes.filter((node) => {
      if ("attribs" in node) {
        // Bound retained metadata independently of which output serializer is used.
        if (Object.keys(node.attribs).length > MAX_HTML_ATTRIBUTES)
          throw new FetchError(
            `Web fetch HTML element exceeded ${MAX_HTML_ATTRIBUTES} attributes.`,
          );
        // htmlparser2 leaves textarea entities encoded. Normalize these containers
        // so both the tree serializer and the readable-text parser see literal text.
        if (node.name === "textarea") {
          node.name = "span";
          for (const child of node.children) {
            if (child.type === "text") child.data = decodeHTML(child.data);
          }
        } else if (node.name === "noscript") {
          node.name = "div";
        }
        if (node.name === "a" && node.attribs.href !== undefined) {
          try {
            const link = new URL(node.attribs.href, url);
            if (!["http:", "https:", "mailto:"].includes(link.protocol))
              throw new Error();
            node.attribs.href = link.href;
            linkBytes += Buffer.byteLength(link.href);
          } catch {
            delete node.attribs.href;
          }
          // Repeated short relative links can expand substantially against a long URL.
          if (linkBytes > MAX_CONVERSION_BYTES)
            throw new FetchError(
              `Web fetch converted content exceeded ${MAX_CONVERSION_BYTES} bytes.`,
            );
        }
      }
      if ("children" in node) {
        // Prune before either converter's recursive traversal.
        node.children =
          depth >= MAX_HTML_DEPTH && node.children.length
            ? parseDocument(DEPTH_NOTICE).children
            : clean(node.children, depth + 1);
      }
      return node.type !== "comment" && node.type !== "directive";
    });
  }

  document.children = normalizeAnchors(clean(document.children, 1));
  function connect(parent: HtmlDocument | HtmlElement): void {
    for (const [index, child] of parent.children.entries()) {
      child.parent = parent;
      child.prev = parent.children[index - 1] ?? null;
      child.next = parent.children[index + 1] ?? null;
      if (isElement(child)) connect(child);
    }
  }
  connect(document);
  // Retain the prepared-HTML budget without materializing or reparsing that HTML.
  writeHtml(document, new ConversionWriter(false), "html");
  return document;
}
