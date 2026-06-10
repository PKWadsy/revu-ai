# Per-rule harness / model / provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each `*.revu.md` rule file choose its own agent `harness`, `model`, and `provider` via YAML frontmatter, overriding the run-global config for that rule only.

**Architecture:** The three keys form one *atomic override group* — if a rule declares any of them, its agent config comes entirely from frontmatter (no merge with global config); if it declares none, it inherits global config exactly as today. Frontmatter parsing (`discovery.ts`) extracts the three scalars and flags present-but-empty values as `""`. The runner validates the group per rule, resolves the effective `{harness, model, provider}`, and instantiates providers lazily through a cache keyed by `harness\0provider\0model` (so the no-override case still yields a single shared instance).

**Tech Stack:** TypeScript (NodeNext ESM), Vitest, `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`, fast-glob, micromatch.

---

## File Structure

- `src/discovery.ts` — **modify**: add `parseFrontmatterScalar` helper; extend `parseFrontmatter` and `discoverRules` to extract/propagate `harness`/`model`/`provider`.
- `src/types.ts` — **modify**: add `harness?`, `model?`, `provider?` to `RuleFile`.
- `src/runner.ts` — **modify**: replace the single up-front provider with `resolveRuleAgent` + a provider-instance cache; reorder `executeRule`; extend `listRules` to surface overrides.
- `src/cli.ts` — **modify**: render the per-rule override bracket in the `list` command.
- `tests/discovery.test.ts` — **modify**: parsing tests for the three new keys.
- `tests/runner.test.ts` — **modify**: resolution / validation / cache / list-visibility tests.
- `README.md`, `CHANGELOG.md`, `package.json` — **modify**: docs + version bump to 0.6.0.

Conventions to match: existing `parseFrontmatter*` helpers (regex-based, quote-stripping), the `...(x !== undefined ? { x } : {})` conditional-spread idiom, and the runner's pattern of returning a failed `RuleResult` (never throwing) for per-rule config errors.

---

## Task 1: Parse `harness` / `model` / `provider` scalars in frontmatter

**Files:**
- Modify: `src/discovery.ts` (`parseFrontmatter` ~line 147; add helper near `parseFrontmatterStage` ~line 208)
- Test: `tests/discovery.test.ts`

Semantics: each key is absent (`undefined`), present-but-empty (`""`), or present-with-value (the trimmed, quote-stripped string). `""` is the signal the runner uses to fail an empty override. No cross-key/group validation here — that lives in the runner (Task 3).

- [ ] **Step 1: Write the failing tests**

Add to `tests/discovery.test.ts` (after the existing `parseFrontmatter — stage:` describe block, ~line 240):

```ts
describe("parseFrontmatter — agent override keys", () => {
  it("parses an unquoted harness, model, and provider", () => {
    const raw = "---\nharness: opencode\nprovider: google\nmodel: gemini-2.5-pro\n---\n# body\n";
    const { harness, model, provider } = parseFrontmatter(raw);
    expect(harness).toBe("opencode");
    expect(model).toBe("gemini-2.5-pro");
    expect(provider).toBe("google");
  });

  it("parses quoted values", () => {
    const raw = '---\nharness: "claude-code"\nmodel: "claude-opus-4-8"\n---\n# body\n';
    const { harness, model } = parseFrontmatter(raw);
    expect(harness).toBe("claude-code");
    expect(model).toBe("claude-opus-4-8");
  });

  it("returns undefined for keys that are absent", () => {
    const { harness, model, provider } = parseFrontmatter('---\nfiles: "**/*.ts"\n---\n# body\n');
    expect(harness).toBeUndefined();
    expect(model).toBeUndefined();
    expect(provider).toBeUndefined();
  });

  it("represents a bare (present-but-empty) key as an empty string", () => {
    const { harness } = parseFrontmatter("---\nharness:\nmodel: claude-opus-4-8\n---\n# body\n");
    expect(harness).toBe("");
  });

  it("coexists with files: and stage:", () => {
    const raw = '---\nstage: 2\nfiles: "**/*.rs"\nharness: opencode\nprovider: xai\nmodel: grok-4\n---\n# body\n';
    const { stage, filePatterns, harness, provider, model } = parseFrontmatter(raw);
    expect(stage).toBe(2);
    expect(filePatterns).toEqual(["**/*.rs"]);
    expect(harness).toBe("opencode");
    expect(provider).toBe("xai");
    expect(model).toBe("grok-4");
  });

  it("returns undefined keys when there is no frontmatter", () => {
    const { harness, model, provider } = parseFrontmatter("# just a heading\n");
    expect(harness).toBeUndefined();
    expect(model).toBeUndefined();
    expect(provider).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/discovery.test.ts -t "agent override keys"`
Expected: FAIL — `harness`/`model`/`provider` are `undefined` (not yet returned by `parseFrontmatter`).

- [ ] **Step 3: Add the `parseFrontmatterScalar` helper**

In `src/discovery.ts`, add after `parseFrontmatterStage` (after ~line 218):

```ts
/**
 * Parse a single optional scalar frontmatter key (e.g. `harness:`, `model:`, `provider:`).
 *  - Key absent          → `undefined`
 *  - Key present, empty   → `""`  (bare `harness:` or `harness: ""`). The runner treats this
 *                            as a broken override and fails the rule, mirroring empty `files:`.
 *  - Key present + value  → the trimmed, quote-stripped string.
 */
function parseFrontmatterScalar(frontmatter: string, key: string): string | undefined {
  // Anchored to line start; key must be followed by `:` then optional value.
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, "m");
  const m = frontmatter.match(re);
  if (!m) return undefined;
  return (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
}
```

- [ ] **Step 4: Extend `parseFrontmatter`'s return shape**

In `src/discovery.ts`, update the `parseFrontmatter` signature and body (~lines 147-161). Change the return type annotation and add the three extractions + conditional spreads:

```ts
export function parseFrontmatter(rawContent: string): {
  content: string;
  filePatterns?: string[];
  stage?: number;
  harness?: string;
  model?: string;
  provider?: string;
} {
  // Frontmatter must start at the very beginning of the file.
  const fmMatch = rawContent.match(/^---[ \t]*\r?\n([\s\S]*?)\n---[ \t]*(\r?\n|$)/);
  if (!fmMatch) return { content: rawContent };

  const frontmatterBlock = fmMatch[1] ?? "";
  const body = rawContent.slice(fmMatch[0].length);
  const filePatterns = parseFrontmatterFiles(frontmatterBlock);
  const stage = parseFrontmatterStage(frontmatterBlock);
  const harness = parseFrontmatterScalar(frontmatterBlock, "harness");
  const model = parseFrontmatterScalar(frontmatterBlock, "model");
  const provider = parseFrontmatterScalar(frontmatterBlock, "provider");
  return {
    content: body,
    ...(filePatterns !== undefined ? { filePatterns } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/discovery.test.ts -t "agent override keys"`
Expected: PASS (6 tests). Also run the full file to confirm no regressions: `npx vitest run tests/discovery.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/discovery.ts tests/discovery.test.ts
git commit -m "feat(discovery): parse harness/model/provider frontmatter scalars"
```

---

## Task 2: Add agent-override fields to `RuleFile` and propagate from discovery

**Files:**
- Modify: `src/types.ts` (`RuleFile` ~lines 11-23)
- Modify: `src/discovery.ts` (`discoverRules` map ~lines 30-47)
- Test: `tests/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

Add a **self-contained** describe block to `tests/discovery.test.ts` (its own temp git repo, so it doesn't disturb the existing `discoverRules` test's exact-list assertion). The imports it needs — `execFileSync`, `mkdirSync`, `mkdtempSync`, `rmSync`, `writeFileSync`, `tmpdir`, `join`, `discoverRules` — are already imported at the top of the file.

```ts
describe("discoverRules — agent override propagation", () => {
  let odir: string;
  beforeAll(() => {
    odir = mkdtempSync(join(tmpdir(), "revu-override-"));
    execFileSync("git", ["init", "-q"], { cwd: odir });
    mkdirSync(join(odir, ".revu"), { recursive: true });
    writeFileSync(
      join(odir, ".revu", "with-override.revu.md"),
      "---\nharness: opencode\nprovider: google\nmodel: gemini-2.5-pro\n---\n# rule",
    );
    writeFileSync(join(odir, ".revu", "plain.revu.md"), "# rule");
  });
  afterAll(() => rmSync(odir, { recursive: true, force: true }));

  it("populates harness/model/provider on discovered rules", async () => {
    const rules = await discoverRules(odir, "**/*.revu.md");
    const overridden = rules.find((r) => r.relPath === ".revu/with-override.revu.md");
    expect(overridden).toBeDefined();
    expect(overridden!.harness).toBe("opencode");
    expect(overridden!.provider).toBe("google");
    expect(overridden!.model).toBe("gemini-2.5-pro");

    const plain = rules.find((r) => r.relPath === ".revu/plain.revu.md");
    expect(plain!.harness).toBeUndefined();
    expect(plain!.model).toBeUndefined();
    expect(plain!.provider).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/discovery.test.ts -t "populates harness/model/provider"`
Expected: FAIL — `overridden.harness` is `undefined` (type doesn't carry the fields, map doesn't set them). May also be a TypeScript error on `.harness`; that's the expected failing state.

- [ ] **Step 3: Add the fields to `RuleFile`**

In `src/types.ts`, add to the `RuleFile` interface (after the `stage?` field, ~line 22):

```ts
  /** Per-rule agent harness override (frontmatter `harness:`). Part of the atomic
   *  {harness, model, provider} override group: if any of the three is present, the
   *  rule's agent config comes entirely from frontmatter. `""` means present-but-empty
   *  (a broken override the runner fails). When all three are absent the rule inherits
   *  the run-global config. */
  harness?: string;
  /** Per-rule model override (frontmatter `model:`). See `harness`. */
  model?: string;
  /** Per-rule provider override (frontmatter `provider:`). See `harness`. */
  provider?: string;
```

- [ ] **Step 4: Propagate the fields in `discoverRules`**

In `src/discovery.ts`, update the `parsed` type annotation and the returned object in the `.map(...)` (~lines 33-46):

```ts
    let parsed: {
      content: string;
      filePatterns?: string[];
      stage?: number;
      harness?: string;
      model?: string;
      provider?: string;
    };
    try {
      parsed = parseFrontmatter(rawContent);
    } catch (e) {
      throw new Error(`${rel}: ${(e as Error).message}`);
    }
    return {
      ruleId: deriveRuleId(rel),
      absPath: abs,
      relPath: rel,
      content: parsed.content,
      ...(parsed.filePatterns !== undefined ? { filePatterns: parsed.filePatterns } : {}),
      ...(parsed.stage !== undefined ? { stage: parsed.stage } : {}),
      ...(parsed.harness !== undefined ? { harness: parsed.harness } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
    };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/discovery.test.ts`
Expected: PASS (including the updated exact-list assertion and the new propagation test).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/discovery.ts tests/discovery.test.ts
git commit -m "feat(types): carry harness/model/provider overrides on RuleFile"
```

---

## Task 3: Per-rule agent resolution, validation, and provider-instance cache

**Files:**
- Modify: `src/runner.ts` (remove single provider at ~lines 102-106; add helper + cache; reorder `executeRule` ~lines 132-212)
- Test: `tests/runner.test.ts`

This is the core change. `resolveRuleAgent` decides the effective `{harness, model, provider}` or returns an error; a `Map` caches one `ReviewAgent` per distinct settings tuple; `executeRule` validates first, then does the file-pattern skip check, then instantiates lazily and runs.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `tests/runner.test.ts`. These tests register mock harnesses that **record the cfg they were instantiated with and which ruleIds ran on them**, so we can assert resolution. Place after the existing top-level helpers:

```ts
import { listRules } from "../src/runner.js";
import { unregisterHarness } from "../src/providers/registry.js";

/** A harness factory that records every cfg it's instantiated with and, per agent run,
 *  which ruleId ran and the cfg of the instance it ran on. Reports a summary so the
 *  review is considered complete. */
function recordingHarness(
  log: { instantiations: Array<{ model?: string; provider?: string }>; runs: Array<{ ruleId: string; model?: string; provider?: string }> },
): ReviewAgentFactory {
  return (cfg: { model?: string; provider?: string }): ReviewAgent => {
    log.instantiations.push({ model: cfg.model, provider: cfg.provider });
    return {
      name: "recording",
      async run(input: ReviewInput) {
        log.runs.push({ ruleId: input.ruleId, model: cfg.model, provider: cfg.provider });
        const client = new Client({ name: "rec", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(input.mcp.url), {
          requestInit: { headers: { Authorization: `Bearer ${input.mcp.authToken}`, "X-Revu-Rule-Id": input.ruleId } },
        });
        try {
          await client.connect(transport);
          await client.callTool({ name: "report_review_summary", arguments: { outcome: "pass", checked: "x", rationale: "y" } });
        } finally {
          await client.close();
        }
        return { ruleId: input.ruleId, ok: true, durationMs: 1 };
      },
    };
  };
}

describe("runner — per-rule agent overrides", () => {
  // `dir` is created by the file-level beforeEach (git repo with .revu/alpha, .revu/beta, src.ts).
  // Each test writes its own override rule files into that repo and commits them.
  function writeRule(rel: string, frontmatter: string) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, `${frontmatter}\n# rule body\n`);
  }

  afterEach(() => {
    unregisterHarness("rec");
    unregisterHarness("rec2");
  });

  it("a rule with no override inherits the global config; one shared instance for many rules", async () => {
    const log = { instantiations: [] as any[], runs: [] as any[] };
    registerHarness("rec", recordingHarness(log));
    // .revu/alpha and .revu/beta already exist (plain, no frontmatter).
    git(dir, "add", "."); git(dir, "commit", "-m", "rules");
    await run(dir, baseConfig({ harness: "rec", model: "global-model", provider: "global-prov" }));
    // Two rules, no overrides → one shared instance, both runs carry the global cfg.
    expect(log.instantiations).toHaveLength(1);
    expect(log.runs.map((r) => r.model)).toEqual(["global-model", "global-model"]);
  });

  it("a full override uses frontmatter settings and ignores global config", async () => {
    const log = { instantiations: [] as any[], runs: [] as any[] };
    registerHarness("rec", recordingHarness(log));   // global harness
    registerHarness("rec2", recordingHarness(log));  // overridden harness
    writeRule(".revu/over.revu.md", "---\nharness: rec2\nprovider: google\nmodel: gemini-2.5-pro\n---");
    git(dir, "add", "."); git(dir, "commit", "-m", "rules");
    await run(dir, baseConfig({ harness: "rec", model: "global-model", provider: "global-prov" }));
    const overRun = log.runs.find((r) => r.ruleId === ".revu/over");
    expect(overRun).toEqual({ ruleId: ".revu/over", model: "gemini-2.5-pro", provider: "google" });
  });

  it("two rules with identical overrides share one provider instance", async () => {
    const log = { instantiations: [] as any[], runs: [] as any[] };
    registerHarness("rec2", recordingHarness(log));
    writeRule(".revu/a.revu.md", "---\nharness: rec2\nprovider: google\nmodel: gemini-2.5-pro\n---");
    writeRule(".revu/b.revu.md", "---\nharness: rec2\nprovider: google\nmodel: gemini-2.5-pro\n---");
    git(dir, "add", "."); git(dir, "commit", "-m", "rules");
    // Use a base harness that won't be exercised here for alpha/beta — register it too.
    registerHarness("rec", recordingHarness({ instantiations: [], runs: [] }));
    await run(dir, baseConfig({ harness: "rec" }));
    const gemini = log.instantiations.filter((i) => i.model === "gemini-2.5-pro");
    expect(gemini).toHaveLength(1);
  });

  it("fails the rule when model is set without harness; other rules still run", async () => {
    registerHarness("rec", recordingHarness({ instantiations: [], runs: [] }));
    writeRule(".revu/bad.revu.md", "---\nmodel: gemini-2.5-pro\n---");
    git(dir, "add", "."); git(dir, "commit", "-m", "rules");
    const { report, exitCode } = await run(dir, baseConfig({ harness: "rec" }));
    const bad = report.rules.find((r) => r.id === ".revu/bad");
    expect(bad!.ok).toBe(false);
    expect(bad!.errorMessage).toMatch(/harness/i);
    expect(exitCode).toBe(2);
    // alpha/beta (no override) still ran and are ok.
    expect(report.rules.find((r) => r.id === ".revu/alpha")!.ok).toBe(true);
  });

  it("fails the rule when harness is opencode but provider is missing", async () => {
    registerHarness("rec", recordingHarness({ instantiations: [], runs: [] }));
    writeRule(".revu/op.revu.md", "---\nharness: opencode\nmodel: grok-4\n---");
    git(dir, "add", "."); git(dir, "commit", "-m", "rules");
    const { report } = await run(dir, baseConfig({ harness: "rec" }));
    const op = report.rules.find((r) => r.id === ".revu/op");
    expect(op!.ok).toBe(false);
    expect(op!.errorMessage).toMatch(/provider/i);
  });

  it("fails the rule when an override key is present but empty", async () => {
    registerHarness("rec", recordingHarness({ instantiations: [], runs: [] }));
    writeRule(".revu/empty.revu.md", "---\nharness:\nmodel: m\n---");
    git(dir, "add", "."); git(dir, "commit", "-m", "rules");
    const { report } = await run(dir, baseConfig({ harness: "rec" }));
    const empty = report.rules.find((r) => r.id === ".revu/empty");
    expect(empty!.ok).toBe(false);
    expect(empty!.errorMessage).toMatch(/empty|harness/i);
  });

  it("fails the rule when the overridden harness is unknown; run continues", async () => {
    registerHarness("rec", recordingHarness({ instantiations: [], runs: [] }));
    writeRule(".revu/unknown.revu.md", "---\nharness: nope-harness\nmodel: m\n---");
    git(dir, "add", "."); git(dir, "commit", "-m", "rules");
    const { report } = await run(dir, baseConfig({ harness: "rec" }));
    const unk = report.rules.find((r) => r.id === ".revu/unknown");
    expect(unk!.ok).toBe(false);
    expect(unk!.errorMessage).toMatch(/unknown review harness/i);
    expect(report.rules.find((r) => r.id === ".revu/alpha")!.ok).toBe(true);
  });
});
```

> Note: the file-level `beforeEach` already calls `registerHarness("mock", ...)`. These tests register their own harnesses (`rec`/`rec2`) and don't rely on `mock`. The base `.revu/alpha` and `.revu/beta` files have no frontmatter, so under `baseConfig({ harness: "rec" })` they resolve to the global `rec` harness — make sure `rec` is registered in every test that lets alpha/beta run.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/runner.test.ts -t "per-rule agent overrides"`
Expected: FAIL — overrides are ignored (the runner instantiates one global provider and routes every rule through it), so e.g. `overRun.model` is `global-model`, and the validation/unknown-harness rules come back `ok: true`.

- [ ] **Step 3: Add the resolver and remove the up-front provider**

In `src/runner.ts`, **remove** the single-provider creation (~lines 102-106):

```ts
  const factory = getHarnessFactory(config.harness);
  const provider = factory({
    ...(config.model ? { model: config.model } : {}),
    ...(config.provider ? { provider: config.provider } : {}),
  });
```

Replace it with a resolver + a provider cache (insert at the same location, after the sidecar subscriptions):

```ts
  // Effective agent settings for a rule: either the run-global config (no override keys)
  // or, when the rule declares any of harness/model/provider, the atomic frontmatter group.
  type ResolvedAgent = { harness: string; model?: string; provider?: string };
  const resolveRuleAgent = (rule: RuleFile): { agent: ResolvedAgent } | { error: string } => {
    const hasOverride =
      rule.harness !== undefined || rule.model !== undefined || rule.provider !== undefined;
    if (!hasOverride) {
      return {
        agent: {
          harness: config.harness,
          ...(config.model !== undefined ? { model: config.model } : {}),
          ...(config.provider !== undefined ? { provider: config.provider } : {}),
        },
      };
    }
    // Atomic group: any key present means the rule must fully specify its agent config.
    // `""` (parsed from a bare/empty key) is present-but-empty and is rejected.
    for (const [key, val] of [
      ["harness", rule.harness],
      ["model", rule.model],
      ["provider", rule.provider],
    ] as const) {
      if (val === "") {
        return { error: `frontmatter \`${key}:\` is empty — give it a value or remove it (harness/model/provider is all-or-nothing)` };
      }
    }
    if (rule.harness === undefined) {
      return { error: "frontmatter sets model/provider without `harness:` — the harness/model/provider override is all-or-nothing" };
    }
    if (rule.model === undefined) {
      return { error: "frontmatter sets `harness:` without `model:` — the harness/model/provider override is all-or-nothing" };
    }
    if (rule.harness === "opencode" && rule.provider === undefined) {
      return { error: "frontmatter `harness: opencode` requires `provider:` (e.g. xai, google, anthropic)" };
    }
    return {
      agent: {
        harness: rule.harness,
        model: rule.model,
        ...(rule.provider !== undefined ? { provider: rule.provider } : {}),
      },
    };
  };

  // Lazily instantiate (and reuse) one ReviewAgent per distinct settings tuple. With no
  // overrides, every rule shares one instance — byte-for-byte today's behavior.
  const providerCache = new Map<string, ReturnType<ReviewAgentFactory>>();
  const getProvider = (a: ResolvedAgent): ReturnType<ReviewAgentFactory> => {
    const key = `${a.harness}\0${a.provider ?? ""}\0${a.model ?? ""}`;
    let p = providerCache.get(key);
    if (!p) {
      const factory = getHarnessFactory(a.harness); // throws on unknown harness — caller catches
      p = factory({
        ...(a.model ? { model: a.model } : {}),
        ...(a.provider ? { provider: a.provider } : {}),
      });
      providerCache.set(key, p);
    }
    return p;
  };
```

Add the needed import — `ReviewAgentFactory` — to the `import type { ... } from "./providers/types.js"` line at the top (it currently imports only `ReviewActivity`):

```ts
import type { ReviewActivity, ReviewAgentFactory } from "./providers/types.js";
```

- [ ] **Step 4: Reorder `executeRule` to validate → skip → instantiate → run**

In `src/runner.ts`, in `executeRule` (~line 132), insert override resolution at the very top (before the `rule.filePatterns` block), and switch the `provider.run` call to use the per-rule instance. Add the resolution at the start of the function body, right after `const ruleStart = Date.now();`:

```ts
    // Validate the agent override first so a broken override is always reported,
    // even for a rule whose files wouldn't match (mirrors the empty-`files:` failure).
    const resolved = resolveRuleAgent(rule);
    if ("error" in resolved) {
      return {
        id: rule.ruleId, path: rule.relPath, ok: false,
        durationMs: Date.now() - ruleStart, findingCount: 0, summaryCount: 0, checkCount: 0,
        errorMessage: resolved.error,
      };
    }
```

Then, after the existing file-pattern checks (the `if (matchingFiles.length === 0)` skip branch returns early, so instantiation below only happens for rules that actually run), resolve the provider just before the `try`. Replace the start of the `try` block's `const result = await provider.run({` so it first obtains the cached instance:

```ts
    let provider: ReturnType<ReviewAgentFactory>;
    try {
      provider = getProvider(resolved.agent);
    } catch (e) {
      return {
        id: rule.ruleId, path: rule.relPath, ok: false,
        durationMs: Date.now() - ruleStart, findingCount: 0, summaryCount: 0, checkCount: 0,
        errorMessage: (e as Error)?.message ?? String(e),
      };
    }

    try {
      const result = await provider.run({
```

Leave the rest of the `try`/`catch` body unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/runner.test.ts -t "per-rule agent overrides"`
Expected: PASS (7 tests). Then run the whole runner suite: `npx vitest run tests/runner.test.ts` → PASS (no regressions in existing gating/skip/prior-finding tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (confirms `ReviewAgentFactory` import + `RuleFile` typing line up).

- [ ] **Step 7: Commit**

```bash
git add src/runner.ts tests/runner.test.ts
git commit -m "feat(runner): resolve harness/model/provider per rule with cached providers"
```

---

## Task 4: Surface overrides in `revu-ai list`

**Files:**
- Modify: `src/runner.ts` (`listRules` ~lines 362-366)
- Modify: `src/cli.ts` (`list` action ~lines 59-71)
- Test: `tests/runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/runner.test.ts` inside the `describe("runner — per-rule agent overrides", ...)` block:

```ts
  it("listRules surfaces the per-rule override settings", async () => {
    writeRule(".revu/op.revu.md", "---\nharness: opencode\nprovider: google\nmodel: gemini-2.5-pro\n---");
    git(dir, "add", "."); git(dir, "commit", "-m", "rules");
    const rules = await listRules(dir, "**/*.revu.md");
    const op = rules.find((r) => r.ruleId === ".revu/op");
    expect(op).toMatchObject({ harness: "opencode", provider: "google", model: "gemini-2.5-pro" });
    const plain = rules.find((r) => r.ruleId === ".revu/alpha");
    expect(plain!.harness).toBeUndefined();
  });
```

(`listRules` is already imported at the top of the file per Task 3, Step 1.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/runner.test.ts -t "listRules surfaces"`
Expected: FAIL — `listRules` returns only `{ relPath, ruleId }`, so `op.harness` is `undefined` (and likely a TS error on the property).

- [ ] **Step 3: Extend `listRules`**

In `src/runner.ts`, update `listRules` (~lines 362-366):

```ts
export async function listRules(
  cwd: string,
  pattern: string,
): Promise<{ relPath: string; ruleId: string; harness?: string; model?: string; provider?: string }[]> {
  const repoRoot = findRepoRoot(cwd);
  const rules = await discoverRules(repoRoot, pattern);
  return rules.map((r) => ({
    relPath: r.relPath,
    ruleId: r.ruleId,
    ...(r.harness !== undefined ? { harness: r.harness } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.provider !== undefined ? { provider: r.provider } : {}),
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/runner.test.ts -t "listRules surfaces"`
Expected: PASS.

- [ ] **Step 5: Render the override in the CLI `list` command**

In `src/cli.ts`, update the print loop in the `list` action (~lines 68-70):

```ts
    for (const r of rules) {
      const seg = r.harness
        ? `  [${[r.harness, r.provider, r.model].filter(Boolean).join("/")}]`
        : "";
      console.log(`${r.ruleId}\t${r.relPath}${seg}`);
    }
```

- [ ] **Step 6: Manually verify the CLI output**

Run (in this repo, which has `.revu/*.revu.md` files):
```bash
npx tsx src/cli.ts list
```
Expected: each rule prints `ruleId<TAB>relPath`; any rule with an override frontmatter also prints `  [harness/provider/model]` (provider segment omitted when absent). Rules without overrides print no bracket.

- [ ] **Step 7: Commit**

```bash
git add src/runner.ts src/cli.ts tests/runner.test.ts
git commit -m "feat(list): show per-rule harness/provider/model overrides"
```

---

## Task 5: Documentation, CHANGELOG, version bump

**Files:**
- Modify: `README.md` ("Writing rule files" section, after the `files:`/scoping subsection ~line 90)
- Modify: `CHANGELOG.md` (top)
- Modify: `package.json` (`version`)

- [ ] **Step 1: Add the README subsection**

In `README.md`, after the "Scoping a rule to specific files" subsection (before "## How it works"), add:

````markdown
### Choosing a harness / model per rule

A rule file can override the agent `harness`, `model`, and `provider` for itself via
frontmatter — handy for running cheap pattern rules on a fast model and reserving a
stronger model for rules that need deep reasoning, or routing one service's rules
through a different provider.

```markdown
---
files: "src/api/**/*.py"
harness: opencode
provider: google
model: gemini-2.5-pro
---
# Python API contract enforcement
```

These three keys are an **atomic group**:

- Set **none** of them → the rule uses the run-global harness/model/provider (CLI flags
  or `revu.config.json`), exactly as before.
- Set **any** of them → the rule's agent config comes **entirely** from frontmatter; the
  global config is not consulted for these three. You must then provide `harness` and
  `model` (and `provider` when `harness: opencode`). An incomplete or empty override
  fails that rule loudly rather than silently falling back.

`revu-ai list` shows each rule's override in brackets, e.g.
`python-api  src/api/contract.revu.md  [opencode/google/gemini-2.5-pro]`.
````

- [ ] **Step 2: Add a CHANGELOG entry**

In `CHANGELOG.md`, add a new top entry (match the existing heading style in the file):

```markdown
## 0.6.0

### Added

- **Per-rule harness / model / provider.** A `*.revu.md` rule file can now override the
  agent `harness`, `model`, and `provider` in its frontmatter. The three keys form an
  atomic group: declare none and the rule inherits the run-global config; declare any and
  the rule's agent config comes entirely from frontmatter (`harness` + `model` required,
  `provider` required for `opencode`). Incomplete or empty overrides fail that rule only.
  `revu-ai list` shows each rule's override as `[harness/provider/model]`.
```

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.5.0"` to `"version": "0.6.0"`.

- [ ] **Step 4: Verify the full suite and build**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: document per-rule harness/model/provider + bump to 0.6.0"
```

---

## Final verification

- [ ] **Run the entire test suite:** `npx vitest run` → all PASS.
- [ ] **Typecheck:** `npx tsc --noEmit` → clean.
- [ ] **Sanity-check the CLI:** `npx tsx src/cli.ts list` prints overrides correctly.
- [ ] **Confirm no-override behavior unchanged:** a repo with no override frontmatter instantiates exactly one provider instance (covered by the Task 3 cache-reuse test).
