import { convert } from "html-to-text";
import { FetchError, type FetchedPage, type FetchFormat } from "./fetch.ts";
import { checkConversionSize, isHtml, prepareHtml } from "./html.ts";
import { toMarkdown } from "./markdown.ts";

export function extractContent(
  page: FetchedPage,
  format: FetchFormat = "markdown",
): string {
  if (!isHtml(page.contentType)) return page.text;
  try {
    const html = prepareHtml(page.text, page.url);
    if (format === "markdown") return checkConversionSize(toMarkdown(html));
    return checkConversionSize(
      convert(html, {
        wordwrap: false,
        selectors: [
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
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError("Web fetch could not extract readable HTML.");
  }
}
