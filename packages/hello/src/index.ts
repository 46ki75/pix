import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hello(pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting: /hello [name]",
    handler: async (args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(`Hello, ${args.trim() || "world"}!`, "info");
      }
    },
  });
}
