import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isAbsolute, relative, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Finding } from "../types.js";
import { ensureFingerprint } from "../findings.js";
import { FindingsAggregator } from "./aggregator.js";
import { isAllowedRuleFileWrite, toRepoRelative } from "../scaffold-paths.js";
import {
  ReportFindingShape,
  REPORT_FINDING_DESCRIPTION,
  MarkResolvedShape,
  MARK_RESOLVED_DESCRIPTION,
  WriteRuleFileShape,
  WRITE_RULE_FILE_DESCRIPTION,
  type ReportFindingInput,
  type MarkResolvedInput,
  type WriteRuleFileInput,
} from "./tools.js";

export interface SidecarHandle {
  url: string;
  authToken: string;
  aggregator: FindingsAggregator;
  shutdown: () => Promise<void>;
}

export interface ScaffoldSidecarOptions {
  /** Fires once per `.revu.md` file successfully written via `write_rule_file`.
   *  The path is repo-relative, forward-slash separated. */
  onFileWritten?: (relPath: string) => void;
}

export interface StartSidecarOptions {
  repoRoot: string;
  host?: string;
  /** If omitted, an ephemeral free port is chosen. */
  port?: number;
  /** When set, the sidecar additionally exposes a `write_rule_file` tool for
   *  scaffold agents that can't enforce path safety in-process (e.g. opencode). */
  scaffold?: ScaffoldSidecarOptions;
}

export async function startSidecar(opts: StartSidecarOptions): Promise<SidecarHandle> {
  const aggregator = new FindingsAggregator();
  const authToken = randomBytes(24).toString("base64url");
  const host = opts.host ?? "127.0.0.1";

  const ctx: HandlerCtx = {
    authToken,
    aggregator,
    repoRoot: opts.repoRoot,
    ...(opts.scaffold ? { scaffold: opts.scaffold } : {}),
  };
  const httpServer = createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
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
      // `httpServer.close` only stops accepting new connections; it then
      // waits for all keep-alive sockets to drain on their own. The
      // opencode harness keeps an MCP keep-alive connection open, and when
      // an opencode child process is killed mid-prompt, its socket is
      // half-closed but never reaches `end` cleanly — `close()` then waits
      // forever. Force-close every open connection so the runner can
      // proceed to emit its summary instead of hanging post-timeout.
      httpServer.closeAllConnections?.();
    });

  return { url, authToken, aggregator, shutdown };
}

interface HandlerCtx {
  authToken: string;
  aggregator: FindingsAggregator;
  repoRoot: string;
  scaffold?: ScaffoldSidecarOptions;
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

      const finding: Finding = ensureFingerprint({
        ruleId,
        severity: args.severity,
        path: normalizePath(args.path, ctx.repoRoot),
        message: args.message,
        ...(args.line !== undefined ? { line: args.line } : {}),
        ...(args.lineEnd !== undefined ? { lineEnd: args.lineEnd } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.priorFp !== undefined ? { priorFp: args.priorFp } : {}),
      });
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

  server.registerTool(
    "mark_finding_resolved",
    {
      description: MARK_RESOLVED_DESCRIPTION,
      inputSchema: MarkResolvedShape,
    },
    async (args: MarkResolvedInput) => {
      ctx.aggregator.markResolved(ruleId, args.fingerprint, args.reason ?? "fixed");
      return {
        content: [
          {
            type: "text",
            text: `Recorded resolution for ${args.fingerprint} (${args.reason ?? "fixed"}).`,
          },
        ],
      };
    },
  );

  if (ctx.scaffold) {
    const scaffold = ctx.scaffold;
    server.registerTool(
      "write_rule_file",
      {
        description: WRITE_RULE_FILE_DESCRIPTION,
        inputSchema: WriteRuleFileShape,
      },
      async (args: WriteRuleFileInput) => {
        if (!isAllowedRuleFileWrite(ctx.repoRoot, args.path)) {
          return errorResult(
            "Refused: write_rule_file only accepts paths ending in `.revu.md` that resolve inside the repository. " +
              "Globals go in `.revu/<topic>.revu.md`; locals go alongside the thing they cover as `<dir>/<topic>.revu.md`.",
          );
        }
        const rel = toRepoRelative(ctx.repoRoot, args.path);
        const abs = isAbsolute(args.path) ? args.path : `${ctx.repoRoot}/${rel}`;
        try {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, args.content, "utf8");
        } catch (e) {
          return errorResult(`Failed to write ${rel}: ${(e as Error).message}`);
        }
        scaffold.onFileWritten?.(rel);
        return { content: [{ type: "text", text: `Wrote ${rel} (${args.content.length} bytes).` }] };
      },
    );
  }

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
