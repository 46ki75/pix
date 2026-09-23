import { convert } from "html-to-text";
import { FetchError, type FetchedPage } from "./fetch.ts";

export function extractText(page: FetchedPage): string {
  if (
    page.contentType !== "text/html" &&
    page.contentType !== "application/xhtml+xml"
  )
    return page.text;
  try {
    return convert(page.text, {
      wordwrap: false,
      // Bound recursive traversal even for pathological, deeply nested markup.
      limits: { maxDepth: 100, ellipsis: "[Deeply nested HTML omitted.]" },
      selectors: [
        ...[
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
          "[hidden]",
          '[aria-hidden="true"]',
        ].map((selector) => ({ selector, format: "skip" })),
        ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
          selector,
          options: { uppercase: false },
        })),
        {
          selector: "tr",
          format: "block",
          options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
        },
        ...["td", "th"].map((selector) => ({
          selector,
          format: "inlineSurround",
          options: { suffix: " | " },
        })),
        {
          selector: "a",
          options: {
            hideLinkHrefIfSameAsText: true,
            pathRewrite: (href: string) => {
              try {
                const link = new URL(href, page.url);
                return ["http:", "https:", "mailto:"].includes(link.protocol)
                  ? link.href
                  : "";
              } catch {
                return "";
              }
            },
          },
        },
      ],
    });
  } catch {
    throw new FetchError("Web fetch could not extract readable HTML.");
  }
}
