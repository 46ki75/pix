import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import { tinyPng } from "./fixtures/server.ts";
import {
  formatResourceList,
  formatResourceResult,
  parseResourceCommand,
  resourceCompletions,
  resourceTemplateVariables,
  resolveResourceUri,
  validateResource,
  validateResourceTemplate,
  type DirectResourceEntry,
  type TemplateResourceEntry,
} from "./resources.ts";

const artifacts: string[] = [];
afterEach(async () => {
  await Promise.all(
    artifacts
      .splice(0)
      .map((path) => rm(dirname(path), { recursive: true, force: true })),
  );
});

const direct: DirectResourceEntry = {
  kind: "resource",
  server: "fixture",
  resource: {
    uri: "fixture://notes/readme",
    name: "README",
    description: "Project notes",
    mimeType: "text/markdown",
    size: 42,
  },
};

const template: TemplateResourceEntry = {
  kind: "template",
  server: "fixture",
  template: {
    uriTemplate: "fixture://users/{user}{?query,lang}",
    name: "User notes",
    description: "Notes for one user",
  },
  variables: ["user", "query", "lang"],
};

test("parses list and read commands with quoted template arguments", () => {
  expect(parseResourceCommand("list fixture")).toEqual({
    action: "list",
    server: "fixture",
  });
  expect(
    parseResourceCommand(
      'read fixture "fixture://users/{user}{?query,lang}" alice query=a\\=b lang=en',
    ),
  ).toEqual({
    action: "read",
    server: "fixture",
    target: "fixture://users/{user}{?query,lang}",
    argumentTokens: [
      { value: "alice" },
      { value: "query=a=b", separator: 5 },
      { value: "lang=en", separator: 4 },
    ],
  });
  expect(() => parseResourceCommand("read fixture")).toThrow("Usage");
});

test("extracts and expands RFC 6570 Level 4 template variables", () => {
  const uriTemplate = "https://example.test{/path*}{?query,lang:2}{#fragment}";
  expect(resourceTemplateVariables(uriTemplate)).toEqual([
    "path",
    "query",
    "lang",
    "fragment",
  ]);
  const entry: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Example", uriTemplate },
    variables: resourceTemplateVariables(uriTemplate),
  };
  expect(
    resolveResourceUri(entry.template.uriTemplate, entry, [
      "docs/reference",
      "query=a b",
      "lang=english",
      "fragment=top",
    ]),
  ).toBe("https://example.test/docs%2Freference?query=a%20b&lang=en#top");
  expect(resolveResourceUri(uriTemplate, entry, [])).toBe(
    "https://example.test",
  );
  expect(resolveResourceUri(uriTemplate, entry, ["query="])).toBe(
    "https://example.test?query=",
  );
  const escapedTemplate = "fixture:///{value}";
  const escaped: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Escaped", uriTemplate: escapedTemplate },
    variables: ["value"],
  };
  expect(
    resolveResourceUri(escapedTemplate, escaped, ["value=it's (ready)*"]),
  ).toBe("fixture:///it%27s%20%28ready%29%2A");

  const reservedTemplate = "fixture:///{+value}";
  const reserved: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Reserved", uriTemplate: reservedTemplate },
    variables: ["value"],
  };
  expect(
    resolveResourceUri(reservedTemplate, reserved, ["value=it's (ready)*"]),
  ).toBe("fixture:///it's%20(ready)*");
  expect(
    resolveResourceUri(reservedTemplate, reserved, ["value=next%2Fpage"]),
  ).toBe("fixture:///next%2Fpage");

  const prefixTripletTemplate = "fixture:///{+value:1}/{value:1}/{value:2}";
  const prefixTriplet: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Prefix triplet", uriTemplate: prefixTripletTemplate },
    variables: ["value"],
  };
  expect(
    resolveResourceUri(prefixTripletTemplate, prefixTriplet, ["value=%2F"]),
  ).toBe("fixture:///%2F/%252F/%252F");

  const duplicatePrefixTemplate = "fixture:///{value:1,value:2}";
  const duplicatePrefix: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: {
      name: "Duplicate prefix",
      uriTemplate: duplicatePrefixTemplate,
    },
    variables: ["value"],
  };
  expect(
    resolveResourceUri(duplicatePrefixTemplate, duplicatePrefix, ["value=ab"]),
  ).toBe("fixture:///a,ab");

  const dynamicSchemeTemplate = "{scheme}://example.test/{id}";
  const dynamicScheme: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Dynamic scheme", uriTemplate: dynamicSchemeTemplate },
    variables: resourceTemplateVariables(dynamicSchemeTemplate),
  };
  expect(
    resolveResourceUri(dynamicSchemeTemplate, dynamicScheme, ["https", "1"]),
  ).toBe("https://example.test/1");

  const dynamicHostTemplate = "https://{host}/notes/{id}";
  const dynamicHost: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Dynamic host", uriTemplate: dynamicHostTemplate },
    variables: resourceTemplateVariables(dynamicHostTemplate),
  };
  expect(
    resolveResourceUri(dynamicHostTemplate, dynamicHost, ["example.test", "1"]),
  ).toBe("https://example.test/notes/1");

  const unicodeTemplate = "https://example.test/café/😀/{item}";
  const unicode: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Unicode", uriTemplate: unicodeTemplate },
    variables: resourceTemplateVariables(unicodeTemplate),
  };
  expect(resolveResourceUri(unicodeTemplate, unicode, ["item=😀"])).toBe(
    "https://example.test/caf%C3%A9/%F0%9F%98%80/%F0%9F%98%80",
  );

  const privateUseTemplate = "fixture:///\u{e000}/\u{f0000}/{item}";
  const privateUse: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Private use", uriTemplate: privateUseTemplate },
    variables: resourceTemplateVariables(privateUseTemplate),
  };
  expect(resolveResourceUri(privateUseTemplate, privateUse, ["item=1"])).toBe(
    "fixture:///%EE%80%80/%F3%B0%80%80/1",
  );

  expect(() =>
    resolveResourceUri(uriTemplate, entry, [
      "path=one",
      "path=two",
      "query=x",
      "lang=en",
      "fragment=top",
    ]),
  ).toThrow("provided more than once");
  expect(() =>
    resolveResourceUri(uriTemplate, entry, [
      `path=${"x".repeat(256 * 1024)}`,
      "query=x",
      "lang=en",
      "fragment=top",
    ]),
  ).toThrow("exceed 256 KiB");

  const repeated: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Repeated", uriTemplate: "fixture:/{x}{x}{x}{x}" },
    variables: ["x"],
  };
  expect(() =>
    resolveResourceUri(repeated.template.uriTemplate, repeated, [
      "x".repeat(5000),
    ]),
  ).toThrow("exceeds 16 KiB");

  const nearLimitTemplate = `fixture:${"a".repeat(16_370)}{x}`;
  const nearLimit: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Near limit", uriTemplate: nearLimitTemplate },
    variables: ["x"],
  };
  expect(resolveResourceUri(nearLimitTemplate, nearLimit, ["x="])).toHaveLength(
    16_378,
  );

  const emptyTemplate = `fixture:${"{x}".repeat(4000)}`;
  const repeatedEmpty: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Repeated empty", uriTemplate: emptyTemplate },
    variables: ["x"],
  };
  expect(resolveResourceUri(emptyTemplate, repeatedEmpty, ["x="])).toBe(
    "fixture:",
  );

  const prefixedTemplate = `fixture:${"{x:1}".repeat(100)}`;
  const repeatedPrefix: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Repeated prefix", uriTemplate: prefixedTemplate },
    variables: ["x"],
  };
  expect(
    resolveResourceUri(prefixedTemplate, repeatedPrefix, [
      "x".repeat(200 * 1024),
    ]),
  ).toBe(`fixture:${"x".repeat(100)}`);

  const prototype: TemplateResourceEntry = {
    kind: "template",
    server: "fixture",
    template: { name: "Prototype", uriTemplate: "fixture:///{__proto__}" },
    variables: ["__proto__"],
  };
  expect(
    resolveResourceUri(prototype.template.uriTemplate, prototype, [
      "__proto__=safe",
    ]),
  ).toBe("fixture:///safe");
});

test.each([
  [
    "https://example.test/{hello}",
    ["hello=Hello World!"],
    "https://example.test/Hello%20World%21",
  ],
  [
    "https://example.test{+path}/here",
    ["path=/foo/bar"],
    "https://example.test/foo/bar/here",
  ],
  [
    "https://example.test/X{.var}",
    ["var=value"],
    "https://example.test/X.value",
  ],
  [
    "https://example.test/X{.var:3}{/var:2}{#var:1}",
    ["var=value"],
    "https://example.test/X.val/va#v",
  ],
  [
    "https://example.test/X{;x:2,y,empty}",
    ["x=1024", "y=768", "empty="],
    "https://example.test/X;x=10;y=768;empty",
  ],
  [
    "https://example.test/X{;x,y,empty}",
    ["x=1024", "y=768", "empty="],
    "https://example.test/X;x=1024;y=768;empty",
  ],
  [
    "https://example.test/?fixed=yes{&x,empty}",
    ["x=1024", "empty="],
    "https://example.test/?fixed=yes&x=1024&empty=",
  ],
] as const)(
  "matches RFC 6570 expansion vector %s",
  (uriTemplate, tokens, expected) => {
    const entry: TemplateResourceEntry = {
      kind: "template",
      server: "fixture",
      template: { name: "RFC vector", uriTemplate },
      variables: resourceTemplateVariables(uriTemplate),
    };
    expect(resolveResourceUri(uriTemplate, entry, [...tokens])).toBe(expected);
  },
);

test.each([
  "fixture:///{",
  "fixture:///{x",
  "fixture:///x}",
  "fixture:///{,x}",
  "fixture:///{x:0}",
  "fixture:///{x:10000}",
  "fixture:///{bad-name}",
  "fixture:///raw space/{x}",
  "fixture:///bad%zz/{x}",
  "fixture:///it's/{x}",
  "fixture:///safe\u202Egnp/{x}",
  "fixture:///safe\u2028line/{x}",
  "fixture:///safe\u2066isolate/{x}",
  `fixture:///{${"x".repeat(257)}}`,
])("rejects invalid URI template %s", (uriTemplate) => {
  expect(() => resourceTemplateVariables(uriTemplate)).toThrow("template");
});

test("validates bounded resource and template metadata", () => {
  expect(() => validateResource(direct.resource)).not.toThrow();
  expect(() => validateResourceTemplate(template.template)).not.toThrow();
  expect(() =>
    validateResource({ ...direct.resource, uri: "fixture://unsafe\u202Ename" }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({ ...direct.resource, uri: "relative/path" }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({ ...direct.resource, uri: "fixture://raw-é" }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({ ...direct.resource, uri: "fixture://notes#one#two" }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({ ...direct.resource, uri: "fixture:///raw[bracket]" }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({
      ...direct.resource,
      uri: "https://user:secret@example.test/notes",
    }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({ ...direct.resource, uri: "fixture://[v1.fe]/notes" }),
  ).not.toThrow();
  expect(() =>
    validateResource({ ...direct.resource, uri: "fixture:///it's-valid" }),
  ).not.toThrow();
  expect(() =>
    validateResource({ ...direct.resource, uri: "fixture:path space" }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({ ...direct.resource, uri: "fixture://bad/%zz" }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({ ...direct.resource, size: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow("metadata");
  expect(() =>
    validateResource({
      ...direct.resource,
      annotations: { audience: ["user", "assistant", "user"] },
    }),
  ).toThrow("metadata");
  expect(() =>
    validateResourceTemplate({
      ...template.template,
      uriTemplate: "fixture:///{bad-name}",
    }),
  ).toThrow("template");
});

test("lists and completes direct resources, templates, and variables", () => {
  expect(formatResourceList([template, direct])).toContain(
    "fixture resource fixture://notes/readme — Project notes",
  );
  expect(formatResourceList([template, direct])).toContain(
    'fixture template "fixture://users/{user}{?query,lang}" [user] [query] [lang] — Notes for one user',
  );
  expect(
    resourceCompletions("", [direct, template])?.map((item) => item.value),
  ).toEqual(["list", "read"]);
  expect(resourceCompletions("read fi", [direct, template])).toContainEqual({
    value: "read fixture",
    label: "fixture",
  });
  expect(resourceCompletions("list ", [], ["empty", "failed"])).toEqual([
    { value: "list empty", label: "empty" },
    { value: "list failed", label: "failed" },
  ]);
  expect(resourceCompletions("read e", [], ["empty"])).toEqual([
    { value: "read empty", label: "empty" },
  ]);
  expect(
    resourceCompletions("read fixture fixture://n", [direct, template]),
  ).toContainEqual({
    value: "read fixture fixture://notes/readme",
    label: "fixture://notes/readme",
    description: "Project notes",
  });
  expect(
    resourceCompletions(
      'read fixture "fixture://users/{user}{?query,lang}" alice q',
      [direct, template],
    ),
  ).toEqual([
    {
      value: 'read fixture "fixture://users/{user}{?query,lang}" alice query=',
      label: "query=",
    },
  ]);
  expect(
    resourceCompletions(
      'read fixture "fixture://users/{user}{?query,lang}" user="a b" l',
      [direct, template],
    ),
  ).toEqual([
    {
      value:
        'read fixture "fixture://users/{user}{?query,lang}" user="a b" lang=',
      label: "lang=",
    },
  ]);
});

test("accepts explicit concrete URIs but rejects arguments without a catalog template", () => {
  expect(resolveResourceUri("fixture://dynamic/1", undefined, [])).toBe(
    "fixture://dynamic/1",
  );
  expect(() =>
    resolveResourceUri("fixture://dynamic/1", undefined, ["value"]),
  ).toThrow("exact URI template");
  expect(() => resolveResourceUri("fixture://bad\nuri", undefined, [])).toThrow(
    "Invalid MCP resource URI",
  );
});

test("formats ordered text and image resource contents with source markers", async () => {
  const result = await formatResourceResult("fixture", {
    contents: [
      {
        uri: "fixture://notes",
        mimeType: "text/plain",
        text: "Reference",
      },
      {
        uri: "fixture://image",
        mimeType: "Image/PNG; source=fixture",
        blob: tinyPng,
      },
    ],
  });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(
      '[MCP resource {"server":"fixture","uri":"fixture://notes","mimeType":"text/plain"}]\n\nReference',
    ),
  });
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining(
      '[MCP resource {"server":"fixture","uri":"fixture://image","mimeType":"Image/PNG; source=fixture"}]',
    ),
  });
  expect(result.content[1]).toEqual({
    type: "image",
    mimeType: "image/png",
    data: tinyPng,
  });
});

test("preserves unsupported blobs and sanitized text in private artifacts", async () => {
  const original = {
    contents: [
      {
        uri: "fixture://binary",
        mimeType: "application/octet-stream",
        blob: "aGVsbG8=",
        _meta: { secret: "content metadata" },
      },
      {
        uri: "fixture://unsafe",
        text: "safe\u001b[31m\u202Espoof",
      },
    ],
    _meta: { secret: "result metadata" },
  };
  const result = await formatResourceResult("fixture", original);
  const path = result.details.fullOutputPath;
  expect(path).toBeDefined();
  if (!path) throw new Error("Missing resource artifact");
  artifacts.push(path);
  expect(result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("MCP resource content omitted"),
      }),
    ]),
  );
  const preview = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  expect(preview).toContain("safe[31mspoof");
  expect(preview).not.toContain("\u001b");
  expect(preview).not.toContain("\u202E");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    contents: [
      {
        uri: "fixture://binary",
        mimeType: "application/octet-stream",
        blob: "aGVsbG8=",
      },
      {
        uri: "fixture://unsafe",
        text: "safe\u001b[31m\u202Espoof",
      },
    ],
  });
});

test("rejects empty, oversized, and invalid read responses", async () => {
  await expect(
    formatResourceResult("fixture", { contents: [] }),
  ).rejects.toThrow("no content");
  await expect(
    formatResourceResult("fixture", {
      contents: [{ uri: "fixture://unsafe\nname", text: "data" }],
    }),
  ).rejects.toThrow("invalid metadata");
  const contents = Array.from({ length: 101 }, (_, index) => ({
    uri: `fixture://${index}`,
    text: "data",
  }));
  await expect(formatResourceResult("fixture", { contents })).rejects.toThrow(
    "too many",
  );
});

// Keep these assignments type-checked against the installed MCP SDK.
const _resource: Resource = direct.resource;
const _template: ResourceTemplate = template.template;
void [_resource, _template];
