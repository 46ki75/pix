import {
  ExtensionInputComponent,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

export interface PromptArgumentInputOptions {
  label: string;
  description?: string;
  guidance: string;
  signal?: AbortSignal;
}

class PromptArgumentInputComponent extends ExtensionInputComponent {
  readonly #tui: TUI;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    done: (value: string | undefined) => void,
    options: PromptArgumentInputOptions,
  ) {
    let finished = false;
    const finish = (value: string | undefined) => {
      if (finished) return;
      finished = true;
      done(value);
    };
    const details = [
      ...(options.description ? [theme.fg("dim", options.description)] : []),
      theme.fg("muted", options.guidance),
    ].join("\n");
    super(
      options.label,
      undefined,
      (value) => finish(value),
      () => finish(undefined),
      { tui, description: details },
    );
    this.#tui = tui;
    this.#signal = options.signal;
    this.#onAbort = () => finish(undefined);
    options.signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (options.signal?.aborted) this.#onAbort();
  }

  override handleInput(data: string): void {
    super.handleInput(data);
    this.#tui.requestRender();
  }

  override dispose(): void {
    this.#signal?.removeEventListener("abort", this.#onAbort);
    super.dispose();
  }
}

export function createPromptArgumentInput(
  tui: TUI,
  theme: Theme,
  done: (value: string | undefined) => void,
  options: PromptArgumentInputOptions,
): ExtensionInputComponent {
  return new PromptArgumentInputComponent(tui, theme, done, options);
}

// Pi 0.87.1's ctx.ui.input renders every title line as accent and ignores its
// placeholder. Reuse its native component through custom UI to style details.
export async function inputPromptArgument(
  ctx: ExtensionCommandContext,
  options: Omit<PromptArgumentInputOptions, "signal">,
): Promise<string | undefined> {
  if (ctx.signal?.aborted) return;
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) =>
    createPromptArgumentInput(tui, theme, done, {
      ...options,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  );
}
