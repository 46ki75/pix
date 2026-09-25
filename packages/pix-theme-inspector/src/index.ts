import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatThemeReport } from "./report.ts";

export default function themeInspector(pi: ExtensionAPI): void {
  pi.registerCommand("theme-colors", {
    description: "Print the active theme's semantic color tokens",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify("/theme-colors requires Pi's terminal UI.", "warning");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("Usage: /theme-colors", "warning");
        return;
      }
      ctx.ui.notify(formatThemeReport(ctx.ui.theme), "info");
    },
  });
}
