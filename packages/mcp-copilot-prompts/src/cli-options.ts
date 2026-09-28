export interface CliOptions {
  roots: string[];
  allowHomeReferences: boolean;
  help: boolean;
  version: boolean;
}

export function selectFallbackRootPath(
  roots: string[],
  workingDirectory: () => string,
): string {
  return roots[0] ?? workingDirectory();
}

export function parseCliArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = {
    roots: [],
    allowHomeReferences: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--root") {
      const path = arguments_[++index];
      if (!path) throw new Error("--root requires a path");
      options.roots.push(path);
    } else if (argument?.startsWith("--root=")) {
      const path = argument.slice("--root=".length);
      if (!path) throw new Error("--root requires a path");
      options.roots.push(path);
    } else if (argument === "--allow-home-references") {
      options.allowHomeReferences = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--version" || argument === "-v") {
      options.version = true;
    } else {
      throw new Error(`unknown option: ${argument ?? ""}`);
    }
  }
  return options;
}
