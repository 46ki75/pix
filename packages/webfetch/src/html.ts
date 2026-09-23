import { decodeHTML } from "entities";
import { DomUtils, parseDocument } from "htmlparser2";
import { FetchError } from "./fetch.ts";

export const MAX_HTML_DEPTH = 100;
export const MAX_HTML_ATTRIBUTES = 256;
export const MAX_CONVERSION_BYTES = 4 * 1024 * 1024;
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

export function checkConversionSize(text: string): string {
  if (Buffer.byteLength(text) > MAX_CONVERSION_BYTES) {
    throw new FetchError(
      `Web fetch converted content exceeded ${MAX_CONVERSION_BYTES} bytes.`,
    );
  }
  return text;
}

export function prepareHtml(html: string, url: string): string {
  const document = parseDocument(html);
  let linkBytes = 0;

  function clean(
    nodes: typeof document.children,
    depth: number,
  ): typeof document.children {
    return nodes.filter((node) => {
      if ("attribs" in node) {
        if (
          omittedTags.has(node.name) ||
          "hidden" in node.attribs ||
          node.attribs["aria-hidden"] === "true"
        )
          return false;
        // Domino reparses this output and deduplicates attributes with a quadratic scan.
        if (Object.keys(node.attribs).length > MAX_HTML_ATTRIBUTES)
          throw new FetchError(
            `Web fetch HTML element exceeded ${MAX_HTML_ATTRIBUTES} attributes.`,
          );
        // htmlparser2 leaves textarea entities encoded, while the serializer treats
        // noscript as raw text. Normalize both before another parser sees the HTML.
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
        // Prune before either converter's recursive traversal, including Turndown's DOM cloning.
        node.children =
          depth >= MAX_HTML_DEPTH && node.children.length
            ? parseDocument(DEPTH_NOTICE).children
            : clean(node.children, depth + 1);
      }
      return node.type !== "comment" && node.type !== "directive";
    });
  }

  document.children = clean(document.children, 1);
  return checkConversionSize(DomUtils.getOuterHTML(document));
}
