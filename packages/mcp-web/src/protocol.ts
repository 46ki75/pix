import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  AnyObjectSchema,
  SchemaOutput,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  InitializeRequestSchema,
  type Notification,
  type Request,
  type Result,
} from "@modelcontextprotocol/sdk/types.js";

export class ProtocolVersionServer extends Server {
  private protocolVersion: string | undefined;

  // Resource links first appeared in MCP 2025-06-18; see CONTRIBUTING.md.
  get supportsResourceLinks(): boolean {
    return (
      this.protocolVersion !== undefined && this.protocolVersion >= "2025-06-18"
    );
  }

  override setRequestHandler<T extends AnyObjectSchema>(
    schema: T,
    handler: (
      request: SchemaOutput<T>,
      extra: RequestHandlerExtra<Request, Notification>,
    ) => Result | Promise<Result>,
  ): void {
    if (!Object.is(schema, InitializeRequestSchema)) {
      super.setRequestHandler(schema, handler);
      return;
    }
    // The SDK has no negotiated-version getter. Observe its initialization
    // result without replacing negotiation or client-capability bookkeeping.
    super.setRequestHandler(schema, async (request, extra) => {
      const result = await handler(request, extra);
      if (typeof result.protocolVersion === "string") {
        this.protocolVersion = result.protocolVersion;
      }
      return result;
    });
  }
}
