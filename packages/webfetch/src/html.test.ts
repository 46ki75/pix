import { DomUtils } from "htmlparser2";
import { expect, test } from "vitest";
import {
  isElement,
  MAX_CONVERSION_BYTES,
  prepareDocument,
  prepareHtml,
} from "./html.ts";

test("retained nodes have consistent ancestry and sibling links after filtering and pruning", () => {
  const document = prepareDocument(
    `<div><script>omitted</script><a href="/">First</a><span hidden>omitted</span><b>Last</b></div>${"<div>".repeat(105)}deep${"</div>".repeat(105)}`,
    "https://example.com/",
  );
  function check(
    parent:
      | typeof document
      | Extract<(typeof document.children)[number], { attribs: unknown }>,
  ): void {
    for (const [index, child] of parent.children.entries()) {
      expect(child.parent).toBe(parent);
      expect(child.prev).toBe(parent.children[index - 1] ?? null);
      expect(child.next).toBe(parent.children[index + 1] ?? null);
      if (isElement(child)) check(child);
    }
  }
  check(document);
  const link = DomUtils.getElementsByTagName("a", document)[0];
  expect(link?.attribs.href).toBe("https://example.com/");
  expect(link?.next && isElement(link.next) && link.next.name).toBe("b");
  expect(DomUtils.textContent(document)).toContain(
    "Deeply nested HTML omitted",
  );
});

test("bounds prepared HTML expansion when attributes require escaping", () => {
  const attr = '"'.repeat(800_000);
  expect(() =>
    prepareHtml(`<div title='${attr}'>Text</div>`, "https://example.com/"),
  ).toThrow(`converted content exceeded ${MAX_CONVERSION_BYTES} bytes`);
});
