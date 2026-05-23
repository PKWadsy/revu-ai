import { describe, it, expect } from "vitest";
import { accumulateAssistantDiagnostics } from "../src/providers/claude-code.js";
import type { ReviewDiagnostics } from "../src/providers/types.js";

function freshDiagnostics(): ReviewDiagnostics {
  return { textChars: 0, findingToolCalls: 0 };
}

describe("accumulateAssistantDiagnostics", () => {
  it("counts trimmed text-block characters", () => {
    const d = freshDiagnostics();
    accumulateAssistantDiagnostics(
      [
        { type: "text", text: "   Let me look at the diff.   " }, // trimmed -> 24 chars
        { type: "text", text: "Found it." }, // 9 chars
      ],
      d,
    );
    expect(d).toEqual({ textChars: 24 + 9, findingToolCalls: 0 });
  });

  it("counts report_finding tool_use blocks but ignores other tools", () => {
    const d = freshDiagnostics();
    accumulateAssistantDiagnostics(
      [
        { type: "tool_use", name: "Read" },
        { type: "tool_use", name: "mcp__revu__report_finding" },
        { type: "tool_use", name: "mcp__revu__report_finding" },
        { type: "tool_use", name: "mcp__revu__mark_finding_resolved" },
        { type: "tool_use", name: "Bash" },
      ],
      d,
    );
    expect(d).toEqual({ textChars: 0, findingToolCalls: 2 });
  });

  it("accumulates across multiple invocations (one per assistant message)", () => {
    const d = freshDiagnostics();
    accumulateAssistantDiagnostics([{ type: "text", text: "hello" }], d);
    accumulateAssistantDiagnostics([{ type: "text", text: "world!" }], d);
    accumulateAssistantDiagnostics(
      [{ type: "tool_use", name: "mcp__revu__report_finding" }],
      d,
    );
    expect(d).toEqual({ textChars: "hello".length + "world!".length, findingToolCalls: 1 });
  });

  it("is a no-op when content is not an array", () => {
    const d = freshDiagnostics();
    accumulateAssistantDiagnostics(undefined, d);
    accumulateAssistantDiagnostics(null, d);
    accumulateAssistantDiagnostics("not-an-array", d);
    expect(d).toEqual({ textChars: 0, findingToolCalls: 0 });
  });
});
