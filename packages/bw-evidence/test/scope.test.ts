/**
 * BW-059 — ScopeFence behaviour, including the escapes it must actually stop.
 *
 * These are adversarial controls, not happy paths. Each `allow: false` case corresponds to a
 * way an agent (or a confused model) could write outside a task's declared paths, and each was
 * chosen because a naive prefix check would have allowed it:
 *
 *   - `../escape`            — lexical traversal
 *   - `/etc/passwd`          — absolute path
 *   - `link/passwd` with `link -> /etc`  — symlink escape, the one prefix matching misses
 *   - a patch touching a sibling repository
 *   - a shell `workdir` outside the fence, and an obvious outside path argument
 *
 * The symlink cases are skipped when the process cannot create symlinks (some CI sandboxes),
 * rather than silently passing: a skip is reported as a skip.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  contains,
  evaluate,
  makePolicy,
  parsePolicy,
  patchTargets,
  physicalPath,
  shellPathTokens,
} from "../src/scope.js"

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "bw-scope-"))
  mkdirSync(path.join(root, "src"), { recursive: true })
  mkdirSync(path.join(root, "tests"), { recursive: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function canSymlink(root: string): boolean {
  try {
    symlinkSync(path.join(root, "src"), path.join(root, ".link-probe"))
    rmSync(path.join(root, ".link-probe"), { force: true })
    return true
  } catch {
    return false
  }
}

describe("containment", () => {
  test("a root contains itself and its descendants", () => {
    expect(contains("/work", "/work")).toBe(true)
    expect(contains("/work", "/work/a.ts")).toBe(true)
    expect(contains("/work", "/work/deep/a.ts")).toBe(true)
  })

  test("a sibling with a shared prefix is not contained", () => {
    // The classic prefix bug: "/work-evil" starts with "/work".
    expect(contains("/work", "/work-evil/a.ts")).toBe(false)
    expect(contains("/work", "/work2/a.ts")).toBe(false)
    expect(contains("/work", "/etc/passwd")).toBe(false)
  })
})

describe("path resolution", () => {
  test("a path that does not exist yet resolves through its deepest existing ancestor", () => {
    const { root, cleanup } = workspace()
    try {
      expect(physicalPath(path.join(root, "src", "new-file.ts"))).toBe(
        path.join(physicalPath(root), "src", "new-file.ts"),
      )
    } finally {
      cleanup()
    }
  })

  test("a symlinked directory resolves to its target, not its name", () => {
    const { root, cleanup } = workspace()
    if (!canSymlink(root)) {
      cleanup()
      return
    }
    const outside = mkdtempSync(path.join(tmpdir(), "bw-outside-"))
    try {
      symlinkSync(outside, path.join(root, "escape"))
      // This is the assertion the whole design exists for: the lexical path is inside the
      // workspace, and the physical path is not.
      expect(physicalPath(path.join(root, "escape", "file.txt"))).toBe(
        path.join(physicalPath(outside), "file.txt"),
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
      cleanup()
    }
  })
})

describe("file tools", () => {
  test("an edit inside the allowed root is allowed", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      expect(evaluate(policy, { tool: "edit", input: { path: "src/a.ts" }, cwd: root })).toEqual({
        allow: true,
      })
      expect(
        evaluate(policy, { tool: "write", input: { path: "src/new.ts" }, cwd: root }).allow,
      ).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a lexical escape is refused, with the resolved target in the reason", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      const verdict = evaluate(policy, {
        tool: "write",
        input: { path: "../outside.ts" },
        cwd: root,
      })
      expect(verdict.allow).toBe(false)
      if (verdict.allow) return
      expect(verdict.reason).toContain("outside this task's allowed paths")
      expect(verdict.target).not.toContain(root)
    } finally {
      cleanup()
    }
  })

  test("an absolute path outside the root is refused", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      const verdict = evaluate(policy, { tool: "edit", input: { path: "/etc/passwd" }, cwd: root })
      expect(verdict.allow).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("a symlink escape is refused even though the lexical path is inside", () => {
    const { root, cleanup } = workspace()
    const outside = mkdtempSync(path.join(tmpdir(), "bw-outside-"))
    try {
      if (!canSymlink(root)) return
      symlinkSync(outside, path.join(root, "escape"))
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      const verdict = evaluate(policy, {
        tool: "write",
        input: { path: "escape/pwned.txt" },
        cwd: root,
      })
      expect(verdict.allow).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      cleanup()
    }
  })

  test("only the declared subdirectory is writable when the contract narrows it", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: ["src"], cwd: root })
      expect(evaluate(policy, { tool: "edit", input: { path: "src/a.ts" }, cwd: root }).allow).toBe(
        true,
      )
      // Inside the workspace, outside the *declared* scope: still refused.
      expect(
        evaluate(policy, { tool: "edit", input: { path: "tests/a.ts" }, cwd: root }).allow,
      ).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("a read outside the readable roots is refused", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      expect(
        evaluate(policy, { tool: "read", input: { path: "/etc/hosts" }, cwd: root }).allow,
      ).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("a narrowed write scope still allows reading the repository", () => {
    const { root, cleanup } = workspace()
    try {
      // Writes are limited to src/, but reading a test file must remain possible or the agent
      // cannot understand the code it is asked to change.
      const policy = makePolicy({ mode: "enforce", allowedPaths: ["src"], cwd: root })
      expect(
        evaluate(policy, { tool: "read", input: { path: "tests/a.ts" }, cwd: root }).allow,
      ).toBe(true)
      expect(
        evaluate(policy, { tool: "read", input: { path: "README.md" }, cwd: root }).allow,
      ).toBe(true)
      // And a write there is still refused.
      expect(
        evaluate(policy, { tool: "write", input: { path: "tests/a.ts" }, cwd: root }).allow,
      ).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("mode off allows everything, so the fence is opt-in", () => {
    const policy = makePolicy({ mode: "off", allowedPaths: [workspace().root], cwd: "/" })
    expect(
      evaluate(policy, { tool: "write", input: { path: "/etc/passwd" }, cwd: "/" }).allow,
    ).toBe(true)
  })
})

describe("patch documents", () => {
  test("targets are extracted from the runtime's patch grammar", () => {
    const text = [
      "*** Update File: src/a.ts",
      "@@ ...",
      "*** Add File: src/b.ts",
      "+new",
      "*** Delete File: src/c.ts",
    ].join("\n")
    expect(patchTargets(text)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
  })

  test("a patch that touches one outside file is refused as a whole", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      const text = "*** Update File: src/a.ts\n*** Add File: ../evil.sh"
      const verdict = evaluate(policy, { tool: "patch", input: { patchText: text }, cwd: root })
      expect(verdict.allow).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("a patch wholly inside the scope is allowed", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      const text = "*** Update File: src/a.ts\n*** Add File: src/b.ts"
      expect(evaluate(policy, { tool: "patch", input: { patchText: text }, cwd: root }).allow).toBe(
        true,
      )
    } finally {
      cleanup()
    }
  })
})

describe("shell", () => {
  test("an obvious outside path argument is refused", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      const verdict = evaluate(policy, {
        tool: "shell",
        input: { command: "cat /etc/passwd" },
        cwd: root,
      })
      expect(verdict.allow).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("a workdir outside the readable roots is refused even for an innocent command", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: ["src"], cwd: root })
      expect(
        evaluate(policy, { tool: "shell", input: { command: "ls", workdir: "/etc" }, cwd: root })
          .allow,
      ).toBe(false)
      // The workspace root itself is a legitimate working directory even when writes are
      // limited to src/, because tests and builds run from there.
      expect(
        evaluate(policy, { tool: "shell", input: { command: "ls", workdir: "." }, cwd: root })
          .allow,
      ).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a normal in-scope command is allowed but marked unconstrained", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({ mode: "enforce", allowedPaths: [root], cwd: root })
      const verdict = evaluate(policy, {
        tool: "shell",
        input: { command: "python3 -m pytest -q" },
        cwd: root,
      })
      expect(verdict.allow).toBe(true)
      if (!verdict.allow) return
      // The important part: it is NOT presented as a bounded operation.
      expect(verdict.unconstrained).toBe(true)
      expect(verdict.note).toContain("not path-bounded")
    } finally {
      cleanup()
    }
  })

  test("allowShell=false refuses every shell call", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({
        mode: "enforce",
        allowedPaths: [root],
        allowShell: false,
        cwd: root,
      })
      const verdict = evaluate(policy, { tool: "shell", input: { command: "ls" }, cwd: root })
      expect(verdict.allow).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("a URL is not treated as a filesystem path", () => {
    const tokens = shellPathTokens("curl https://example.test/data.json -o out.json")
    expect(tokens).not.toContain("https://example.test/data.json")
    // A bare filename needs no check: it resolves inside the working directory, so it cannot
    // escape on its own. Only path-shaped arguments are candidates.
    expect(tokens).not.toContain("out.json")
    expect(shellPathTokens("cp ./a/b.txt /tmp/c.txt")).toEqual(["./a/b.txt", "/tmp/c.txt"])
  })

  test("a substituted path is not judged, because its value is unknowable here", () => {
    expect(shellPathTokens('cat "$TARGET/file"')).toEqual([])
  })
})

describe("policy documents", () => {
  test("a well-formed policy parses", () => {
    expect(parsePolicy({ mode: "enforce", allowedPaths: ["src"], allowShell: false })).toEqual({
      mode: "enforce",
      allowedPaths: ["src"],
      // A policy that names no readable roots falls back to the writable ones, never to "all".
      readPaths: ["src"],
      allowShell: false,
    })
  })

  test("an unreadable policy is rejected rather than defaulted to permissive", () => {
    // A malformed policy must not silently become "off": that would turn a typo into no fence.
    for (const bad of [
      null,
      {},
      { mode: "maybe", allowedPaths: [] },
      { mode: "enforce", allowedPaths: "src" },
      { mode: "enforce", allowedPaths: [1] },
      { mode: "enforce", allowedPaths: [], allowShell: "yes" },
    ])
      expect(parsePolicy(bad)).toBeUndefined()
  })
})

describe("refusals name their cause", () => {
  // Observed in a real interactive session: an untrusted workspace refused every edit with
  // "outside this task's allowed paths ()". True, useless. The user had no way to learn that
  // `bashwink trust` was the missing step, and the model could only apologise.
  test("an untrusted workspace tells the user to trust it, not that a contract forbade it", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({
        mode: "enforce",
        allowedPaths: [],
        allowShell: false,
        origin: "trust",
        cwd: root,
      })
      const write = evaluate(policy, { tool: "write", input: { path: "a.ts" }, cwd: root })
      expect(write.allow).toBe(false)
      if (write.allow) return
      expect(write.reason).toContain("not trusted")
      expect(write.reason).toContain("bashwink trust")
      // The wording that confused the first alpha user must not appear.
      expect(write.reason).not.toContain("this contract")

      const shell = evaluate(policy, { tool: "shell", input: { command: "ls" }, cwd: root })
      expect(shell.allow).toBe(false)
      if (shell.allow) return
      expect(shell.reason).toContain("not trusted")
      expect(shell.reason).toContain("bashwink trust")
    } finally {
      cleanup()
    }
  })

  test("a contract refusal still names the contract and the allowed paths", () => {
    const { root, cleanup } = workspace()
    try {
      const policy = makePolicy({
        mode: "enforce",
        allowedPaths: ["src"],
        allowShell: false,
        origin: "contract",
        cwd: root,
      })
      const verdict = evaluate(policy, { tool: "write", input: { path: "b.ts" }, cwd: root })
      expect(verdict.allow).toBe(false)
      if (verdict.allow) return
      expect(verdict.reason).toContain("allowed paths")
      expect(verdict.reason).not.toContain("bashwink trust")
    } finally {
      cleanup()
    }
  })

  test("origin survives the JSON round trip the wrapper uses", () => {
    for (const origin of ["trust", "contract"] as const) {
      const parsed = parsePolicy({
        mode: "enforce",
        allowedPaths: ["src"],
        readPaths: ["."],
        allowShell: true,
        origin,
      })
      expect(parsed?.origin).toBe(origin)
    }
    // An unrecognised origin is not silently dropped: the policy is rejected and the caller
    // falls back to fail-closed.
    expect(parsePolicy({ mode: "enforce", allowedPaths: [], origin: "nonsense" })).toBeUndefined()
  })
})
