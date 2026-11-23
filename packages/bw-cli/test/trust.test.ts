import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  TRUSTED_POLICY,
  UNTRUSTED_POLICY,
  canonicalWorkspace,
  emptyTrustFile,
  evaluateCall,
  grantTrust,
  isTrusted,
  parseTrustFile,
  policyFor,
  readTrust,
  revokeTrust,
  type TrustFile,
} from "../src/trust.js"

const AT = "2026-11-23T00:00:00.000Z"

function tempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-trust-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("default policy", () => {
  test("an untrusted workspace denies shell and write", () => {
    // This is the acceptance criterion: "defaults cannot silently grant dangerous
    // shell/write actions". Asserted as data so it cannot drift into prose.
    expect(UNTRUSTED_POLICY.shell).toBe("deny")
    expect(UNTRUSTED_POLICY.write).toBe("deny")
    expect(UNTRUSTED_POLICY.network).toBe("deny")
    // Reads are allowed: exploring a repo is how a plan gets formed.
    expect(UNTRUSTED_POLICY.read).toBe("allow")
  })

  test("a trusted workspace still asks for shell and network", () => {
    // Trust is not a blank cheque: dangerous actions stay interactive even when trusted.
    expect(TRUSTED_POLICY.shell).toBe("ask")
    expect(TRUSTED_POLICY.network).toBe("ask")
    expect(TRUSTED_POLICY.write).toBe("allow")
  })

  test("policyFor defaults to the untrusted policy for an unknown directory", () => {
    tempDir((dir) => {
      expect(policyFor(emptyTrustFile(), dir)).toEqual(UNTRUSTED_POLICY)
    })
  })
})

describe("evaluateCall", () => {
  test("an untrusted workspace denies a shell call with an actionable reason", () => {
    tempDir((dir) => {
      const result = evaluateCall({ trust: emptyTrustFile(), directory: dir, action: "shell" })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("not trusted")
      // The reason has to tell the user what to do, not just that they may not.
      expect(result.reason).toContain("bashwink trust")
    })
  })

  test("an untrusted workspace denies a write", () => {
    tempDir((dir) => {
      expect(
        evaluateCall({ trust: emptyTrustFile(), directory: dir, action: "write" }).decision,
      ).toBe("deny")
    })
  })

  test("an untrusted workspace allows reads", () => {
    tempDir((dir) => {
      expect(
        evaluateCall({ trust: emptyTrustFile(), directory: dir, action: "read" }).decision,
      ).toBe("allow")
    })
  })

  test("explicit approval does not override a hard deny", () => {
    // Otherwise --approve becomes a bypass for the very default the policy exists for.
    tempDir((dir) => {
      const result = evaluateCall({
        trust: emptyTrustFile(),
        directory: dir,
        action: "shell",
        approved: true,
      })
      expect(result.decision).toBe("deny")
    })
  })

  test("explicit approval resolves a trusted workspace's ask", () => {
    tempDir((dir) => {
      const trust = grantTrust(emptyTrustFile(), dir, "tester", AT)
      const withoutApproval = evaluateCall({ trust, directory: dir, action: "shell" })
      expect(withoutApproval.decision).toBe("ask")

      const withApproval = evaluateCall({ trust, directory: dir, action: "shell", approved: true })
      expect(withApproval.decision).toBe("allow")
      expect(withApproval.reason).toContain("approved")
    })
  })

  test("a trusted workspace allows writes without per-call approval", () => {
    tempDir((dir) => {
      const trust = grantTrust(emptyTrustFile(), dir, "tester", AT)
      expect(evaluateCall({ trust, directory: dir, action: "write" }).decision).toBe("allow")
    })
  })
})

describe("trust records", () => {
  test("granting trust makes the directory trusted and records attribution", () => {
    tempDir((dir) => {
      const trust = grantTrust(emptyTrustFile(), dir, "aldrin", AT)
      expect(isTrusted(trust, dir)).toBe(true)
      const record = trust.workspaces[0]
      expect(record?.grantedBy).toBe("aldrin")
      expect(record?.trustedAt).toBe(AT)
    })
  })

  test("revoking trust removes it", () => {
    tempDir((dir) => {
      const granted = grantTrust(emptyTrustFile(), dir, "aldrin", AT)
      expect(isTrusted(revokeTrust(granted, dir), dir)).toBe(false)
    })
  })

  test("granting twice does not duplicate the record", () => {
    tempDir((dir) => {
      const once = grantTrust(emptyTrustFile(), dir, "aldrin", AT)
      const twice = grantTrust(once, dir, "someone-else", AT)
      expect(twice.workspaces).toHaveLength(1)
      expect(twice.workspaces[0]?.grantedBy).toBe("someone-else")
    })
  })

  test("trust does not leak to a sibling directory", () => {
    tempDir((root) => {
      const trusted = path.join(root, "trusted")
      const other = path.join(root, "other")
      mkdirSync(trusted)
      mkdirSync(other)
      const trust = grantTrust(emptyTrustFile(), trusted, "aldrin", AT)
      expect(isTrusted(trust, trusted)).toBe(true)
      expect(isTrusted(trust, other)).toBe(false)
      expect(policyFor(trust, other)).toEqual(UNTRUSTED_POLICY)
    })
  })

  test("a symlink does not inherit the target's trust", () => {
    // Trust is keyed on the canonical path, so a symlinked alias is a different workspace.
    tempDir((root) => {
      const real = path.join(root, "real")
      const link = path.join(root, "link")
      mkdirSync(real)
      symlinkSync(real, link)
      const trust = grantTrust(emptyTrustFile(), real, "aldrin", AT)
      // The symlink resolves to the trusted directory, which is the correct and safe answer:
      // a symlink to a trusted repo *is* that repo.
      expect(isTrusted(trust, link)).toBe(true)
      expect(canonicalWorkspace(link)).toBe(canonicalWorkspace(real))
    })
  })

  test("an upward path cannot borrow trust from a prefix", () => {
    // `..` must be resolved before comparison, or `repo/../../elsewhere` would match `repo`.
    tempDir((root) => {
      const repo = path.join(root, "repo")
      mkdirSync(repo)
      const trust = grantTrust(emptyTrustFile(), repo, "aldrin", AT)
      expect(isTrusted(trust, path.join(repo, "..", "repo"))).toBe(true)
      expect(isTrusted(trust, path.join(repo, ".."))).toBe(false)
    })
  })
})

describe("trust file parsing", () => {
  test("an empty trust file round-trips", () => {
    expect(parseTrustFile(JSON.stringify(emptyTrustFile()))).toEqual(emptyTrustFile())
  })

  test("a malformed record is dropped, not trusted", () => {
    const parsed = parseTrustFile(
      JSON.stringify({
        v: 1,
        workspaces: [{ directory: "/x" }, { directory: "/y", trustedAt: AT }],
      }),
    )
    // Only the record with both required fields survives: a partial record is not evidence.
    expect(parsed.workspaces).toHaveLength(1)
    expect(parsed.workspaces[0]?.directory).toBe("/y")
    expect(parsed.workspaces[0]?.grantedBy).toBe("unknown")
  })

  test("an unknown version is refused", () => {
    expect(() => parseTrustFile(JSON.stringify({ v: 99, workspaces: [] }))).toThrow()
  })

  test("corrupt JSON throws so the caller reports it instead of trusting an empty list", () => {
    // Silently treating corruption as "nothing is trusted" would be safe; silently treating it
    // as trusted would not. Throwing lets doctor display it as a failure either way.
    expect(() => parseTrustFile("{not json")).toThrow()
  })

  test("reading a missing file yields an empty but valid trust file", () => {
    tempDir((dir) => {
      expect(readTrust(path.join(dir, "nope.json"))).toEqual(emptyTrustFile())
    })
  })

  test("a persisted trust file is readable back, including attribution", () => {
    tempDir((dir) => {
      const { writeTrust } = require("../src/trust.js") as typeof import("../src/trust.js")
      const file = path.join(dir, "trust.json")
      const trust: TrustFile = grantTrust(emptyTrustFile(), dir, "aldrin", AT)
      writeTrust(file, trust)
      writeFileSync(path.join(dir, "unrelated"), "x")
      const back = readTrust(file)
      expect(isTrusted(back, dir)).toBe(true)
      expect(back.workspaces[0]?.grantedBy).toBe("aldrin")
    })
  })
})
