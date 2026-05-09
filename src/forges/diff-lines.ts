/**
 * Parse a unified diff produced by `git diff` (or GitHub's
 * `application/vnd.github.v3.diff` representation) into a map of
 * `<path> → Set<post-image line numbers>` containing every "added" line.
 *
 * Inline review comments on most forges can only be posted on lines that
 * were added or modified in the diff. Context lines and removed lines are
 * not commentable. We only track post-image (RIGHT-side) line numbers.
 */
export function parseUnifiedDiff(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  if (!diff) return result;

  const lines = diff.split(/\r?\n/);
  let currentPath: string | undefined;
  let currentSet: Set<number> | undefined;
  let newLineNo = 0;
  let inHunk = false;
  let isBinary = false;

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      currentPath = undefined;
      currentSet = undefined;
      newLineNo = 0;
      inHunk = false;
      isBinary = false;
      continue;
    }

    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      isBinary = true;
      continue;
    }

    if (raw.startsWith("+++ ")) {
      // "+++ b/path/to/file" or "+++ /dev/null"
      const tail = raw.slice(4);
      if (tail === "/dev/null") {
        currentPath = undefined;
      } else {
        currentPath = tail.startsWith("b/") ? tail.slice(2) : tail;
        if (!isBinary) {
          currentSet = result.get(currentPath) ?? new Set<number>();
          result.set(currentPath, currentSet);
        }
      }
      inHunk = false;
      continue;
    }

    if (raw.startsWith("@@")) {
      // @@ -oldStart,oldLen +newStart,newLen @@ optional context
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m && m[1]) {
        newLineNo = Number.parseInt(m[1], 10);
        inHunk = true;
      } else {
        inHunk = false;
      }
      continue;
    }

    if (!inHunk || !currentSet || isBinary) continue;

    const first = raw.charAt(0);
    if (first === "+") {
      // Added line — commentable.
      currentSet.add(newLineNo);
      newLineNo++;
    } else if (first === " ") {
      // Context line — advances the new-side counter but not commentable.
      newLineNo++;
    } else if (first === "-") {
      // Removed line — does not advance the new-side counter.
    } else if (first === "\\") {
      // "\ No newline at end of file" — skip.
    } else if (raw.length === 0) {
      // Blank trailing line; skip.
    } else {
      // Unexpected line shape; bail out of the hunk.
      inHunk = false;
    }
  }

  return result;
}

/** Convenience: is `(path, line)` postable as an inline comment based on the parsed diff? */
export function isInlineable(map: Map<string, Set<number>>, path: string, line: number): boolean {
  return map.get(path)?.has(line) ?? false;
}
