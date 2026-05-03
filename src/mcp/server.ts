import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isAbsolute, relative } from "node:path";
import type { AddressInfo } from "node:net";
import type { Finding } from "../types.js";
import { FindingsAggregator } from "./aggregator.js";
import { ReportFindingShape, REPORT_FINDING_DESCRIPTION, type ReportFindingInput } from "./tools.js";

export interface SidecarHandle {
  url: string;
  authToken: string;
  aggregator: FindingsAggregator;
  shutdown: () => Promise<void>;
}

export interface StartSidecarOptions {
  repoRoot: string;
  host?: string;
  /** If omitted, an ephemeral free port is chosen. */
  port?: number;
}

export async function startSidecar(opts: StartSidecarOptions): Promise<SidecarHandle> {
  const aggregator = new FindingsAggregator();
  const authToken = randomBytes(24).toString("base64url");
  const host = opts.host ?? "127.0.0.1";

  const httpServer = createServer((req, res) => {
    handle(req, res, { authToken, aggregator, repoRoot: opts.repoRoot }).catch((e) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(`internal error: ${(e as Error).message}`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 0, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const url = `http://${host}:${addr.port}/mcp`;

  const shutdown = () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });

  return { url, authToken, aggregator, shutdown };
}

interface HandlerCtx {
  authToken: string;
  aggregator: FindingsAggregator;
  repoRoot: string;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  if (!req.url?.startsWith("/mcp")) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || auth !== `Bearer ${ctx.authToken}`) {
    res.statusCode = 401;
    res.end("unauthorized");
    return;
  }

  const ruleIdHeader = req.headers["x-revu-rule-id"];
  const ruleId = typeof ruleIdHeader === "string" && ruleIdHeader.length > 0 ? ruleIdHeader : "unknown";

  const mcp = buildMcpServer(ruleId, ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close().catch(() => {});
    void mcp.close().catch(() => {});
  });

  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

function buildMcpServer(ruleId: string, ctx: HandlerCtx): McpServer {
  const server = new McpServer({ name: "revu-sidecar", version: "0.0.1" });

  server.registerTool(
    "report_finding",
    {
      description: REPORT_FINDING_DESCRIPTION,
      inputSchema: ReportFindingShape,
    },
    async (args: ReportFindingInput) => {
      if (args.lineEnd !== undefined && args.line === undefined) {
        return errorResult("`line` is required when `lineEnd` is set.");
      }
      if (args.lineEnd !== undefined && args.line !== undefined && args.lineEnd < args.line) {
        return errorResult("`lineEnd` must be >= `line`.");
      }

      const finding: Finding = {
        ruleId,
        severity: args.severity,
        path: normalizePath(args.path, ctx.repoRoot),
        message: args.message,
        ...(args.line !== undefined ? { line: args.line } : {}),
        ...(args.lineEnd !== undefined ? { lineEnd: args.lineEnd } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
      };
      const accepted = ctx.aggregator.add(finding);
      return {
        content: [
          {
            type: "text",
            text: accepted
              ? `Recorded ${finding.severity} finding for ${finding.path}.`
              : `Duplicate finding for ${finding.path}; ignored.`,
          },
        ],
      };
    },
  );

  return server;
}

function normalizePath(input: string, repoRoot: string): string {
  if (isAbsolute(input)) {
    const rel = relative(repoRoot, input);
    return rel.split("\\").join("/");
  }
  return input.split("\\").join("/");
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
