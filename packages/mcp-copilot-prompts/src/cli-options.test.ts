import { describe, expect, it } from "vitest";
import { parseCliArguments, selectFallbackRootPath } from "./cli-options.js";

describe("parseCliArguments", () => {
  it("parses repeatable roots and compatibility flags", () => {
    expect(
      parseCliArguments([
        "--root",
        "one",
        "--root=two",
        "--allow-home-references",
      ]),
    ).toEqual({
      roots: ["one", "two"],
      allowHomeReferences: true,
      help: false,
      version: false,
    });
  });

  it.each([["--root"], ["--root="], ["project"], ["--unknown"]])(
    "rejects invalid arguments %#",
    (...arguments_) => {
      expect(() => parseCliArguments(arguments_)).toThrow();
    },
  );
});

describe("selectFallbackRootPath", () => {
  it("does not inspect the working directory when a root is explicit", () => {
    expect(
      selectFallbackRootPath(["project"], () => {
        throw new Error("working directory is unavailable");
      }),
    ).toBe("project");
  });
});
