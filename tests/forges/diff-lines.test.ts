import { describe, it, expect } from "vitest";
import { isInlineable, parseUnifiedDiff } from "../../src/forges/diff-lines.js";

const SIMPLE = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 unchanged
-removed
+added-1
+added-2
 still-unchanged
`;

describe("parseUnifiedDiff", () => {
  it("returns added line numbers on the new side", () => {
    const m = parseUnifiedDiff(SIMPLE);
    expect(m.get("src/foo.ts")).toEqual(new Set([2, 3]));
  });

  it("excludes context lines", () => {
    const m = parseUnifiedDiff(SIMPLE);
    expect(m.get("src/foo.ts")?.has(1)).toBe(false);
    expect(m.get("src/foo.ts")?.has(4)).toBe(false);
  });

  it("handles multiple files", () => {
    const diff = `${SIMPLE}diff --git a/src/bar.ts b/src/bar.ts
index 3333333..4444444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,2 +10,3 @@
 ten
+eleven
 twelve
`;
    const m = parseUnifiedDiff(diff);
    expect(m.get("src/foo.ts")).toEqual(new Set([2, 3]));
    expect(m.get("src/bar.ts")).toEqual(new Set([11]));
  });

  it("handles multi-hunk single file", () => {
    const diff = `diff --git a/x b/x
index 1..2 100644
--- a/x
+++ b/x
@@ -1,1 +1,2 @@
 a
+new-2
@@ -10,1 +11,2 @@
 ten
+new-12
`;
    const m = parseUnifiedDiff(diff);
    expect(m.get("x")).toEqual(new Set([2, 12]));
  });

  it("skips binary file changes", () => {
    const diff = `diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/x.ts b/x.ts
index 3..4 100644
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,2 @@
 a
+new
`;
    const m = parseUnifiedDiff(diff);
    expect(m.has("img.png")).toBe(false);
    expect(m.get("x.ts")).toEqual(new Set([2]));
  });

  it("handles a newly created file", () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line1
+line2
`;
    const m = parseUnifiedDiff(diff);
    expect(m.get("new.ts")).toEqual(new Set([1, 2]));
  });

  it("returns an empty map for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual(new Map());
  });
});

describe("isInlineable", () => {
  it("is true for added lines, false otherwise", () => {
    const m = parseUnifiedDiff(SIMPLE);
    expect(isInlineable(m, "src/foo.ts", 2)).toBe(true);
    expect(isInlineable(m, "src/foo.ts", 3)).toBe(true);
    expect(isInlineable(m, "src/foo.ts", 1)).toBe(false);
    expect(isInlineable(m, "src/foo.ts", 99)).toBe(false);
    expect(isInlineable(m, "missing.ts", 1)).toBe(false);
  });
});
