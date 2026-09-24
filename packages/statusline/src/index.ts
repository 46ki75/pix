import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFooter } from "./footer.ts";
import { resolveLocation } from "./location.ts";

export default function statusline(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const location = await resolveLocation(ctx.cwd, pi.exec);
    ctx.ui.setFooter((tui, theme, footerData) =>
      createFooter(ctx, tui, theme, footerData, location),
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
