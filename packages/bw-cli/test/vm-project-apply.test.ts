import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { directoryIdentity, regularFile } from "../src/native-stage.js"
import { reconcileVmProjectReceipts } from "../src/vm-project.js"
import {
  recoverVmProject,
  reviewVmProjectWithApproval,
  type VmBase,
} from "../src/vm-project-apply.js"

describe.skipIf(process.platform !== "darwin")("reviewed VM project apply", () => {
  let directory: string
  let root: string
  let workspace: string

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bashwink-vm-apply-")))
    root = path.join(directory, "project")
    workspace = path.join(directory, "workspace")
    mkdirSync(root, { mode: 0o700 })
    mkdirSync(workspace)
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  const encoded = (value: string) => Buffer.from(value).toString("base64")
  const approved = () => Promise.resolve(true)
  const host = (name: string) => path.join(workspace, name)

  function original(name: string, contents: string): VmBase {
    writeFileSync(host(name), contents)
    const file = regularFile(host(name))
    return { ...file, data: file.data.toString("base64") }
  }

  test("applies exactly the reviewed and selected add, modify, and delete operations", async () => {
    const base = {
      "change.js": original("change.js", "before\n"),
      "delete.js": original("delete.js", "remove"),
      "keep.js": original("keep.js", "keep"),
    }
    await reviewVmProjectWithApproval(
      root,
      workspace,
      base,
      { "change.js": encoded("after"), "add.js": encoded("new\n"), "keep.js": encoded("ignore") },
      ["delete.js", "change.js", "add.js"],
      {
        approve: async (diff) => {
          expect(diff).toContain("@@ add.js (added) @@\n+ new\n")
          expect(diff).toContain("@@ change.js (modified) @@\n- before\n+ after\n")
          expect(diff).toContain("@@ delete.js (deleted) @@\n- remove\n")
          expect(diff).toContain("\\ No newline at end of file")
          expect(diff).not.toContain("keep.js")
          return true
        },
      },
    )
    expect(readdirSync(workspace).sort()).toEqual(["add.js", "change.js", "keep.js"])
    expect(readFileSync(host("add.js"), "utf8")).toBe("new\n")
    expect(readFileSync(host("change.js"), "utf8")).toBe("after")
    expect(readFileSync(host("keep.js"), "utf8")).toBe("keep")
    recoverVmProject(root, workspace)
    const [filename] = readdirSync(root)
    expect(filename).toMatch(/^apply-receipt-[a-f0-9-]{36}\.json$/)
    const receipt = JSON.parse(readFileSync(path.join(root, filename!), "utf8")).record
    expect(receipt.outcome).toBe("committed")
    expect(receipt.files.map(({ name }: { name: string }) => name)).toEqual([
      "add.js",
      "change.js",
      "delete.js",
    ])
    const { data: _, ...installed } = regularFile(host("change.js"))
    expect(receipt.files[1].after).toEqual(installed)
    expect(receipt.files[2].after).toBeNull()
  })

  test("refreshes only committed files in the project baseline and does not replay receipts", async () => {
    const base = {
      "one.js": original("one.js", "one before"),
      "two.js": original("two.js", "two before"),
    }
    const files = { "one.js": encoded("one after"), "two.js": encoded("two after") }
    await reviewVmProjectWithApproval(root, workspace, base, files, ["one.js"], {
      approve: approved,
    })
    const record = {
      version: 1 as const,
      project: workspace,
      identity: directoryIdentity(workspace),
      revision: "a".repeat(40),
      profile: "fixture",
      base,
      snapshot: { token: "583ac076-7196-4c56-8af8-099829254ff8", files, state: {}, sessions: [] },
    }
    const filename = path.join(root, "checkpoint.json")
    const refreshed = reconcileVmProjectReceipts(root, workspace, filename, record)
    expect(refreshed.base["one.js"]?.data).toBe(files["one.js"])
    expect(refreshed.base["two.js"]?.data).toBe(base["two.js"].data)
    const checkpoint = readFileSync(filename)
    expect(reconcileVmProjectReceipts(root, workspace, filename, refreshed)).toEqual(refreshed)
    expect(readFileSync(filename)).toEqual(checkpoint)
    await reviewVmProjectWithApproval(root, workspace, refreshed.base, files, undefined, {
      approve: async (diff) => {
        expect(diff).toContain("@@ two.js (modified) @@")
        expect(diff).not.toContain("@@ one.js")
        return false
      },
    })
  })

  test("refreshes consecutive batches and rejects later host conflicts", async () => {
    const base = { "one.js": original("one.js", "before") }
    const firstFiles = { "one.js": encoded("first") }
    const snapshot = {
      token: "583ac076-7196-4c56-8af8-099829254ff8",
      files: firstFiles,
      state: {},
      sessions: [],
    }
    const initial = {
      version: 1 as const,
      project: workspace,
      identity: directoryIdentity(workspace),
      revision: "a".repeat(40),
      profile: "fixture",
      base,
      snapshot,
    }
    const filename = path.join(root, "checkpoint.json")
    await reviewVmProjectWithApproval(root, workspace, initial.base, firstFiles, undefined, {
      approve: approved,
    })
    const first = reconcileVmProjectReceipts(root, workspace, filename, initial)
    const secondFiles = { "one.js": encoded("second") }
    const next = { ...first, snapshot: { ...snapshot, files: secondFiles } }
    await reviewVmProjectWithApproval(root, workspace, next.base, secondFiles, undefined, {
      approve: approved,
    })
    const second = reconcileVmProjectReceipts(root, workspace, filename, next)
    expect(second.base["one.js"]?.data).toBe(secondFiles["one.js"])
    expect(second.appliedReceipts).toHaveLength(2)
    expect(
      await reviewVmProjectWithApproval(root, workspace, second.base, secondFiles, undefined, {
        approve: () => {
          throw new Error("unchanged files must not require approval")
        },
      }),
    ).toBe(false)
    writeFileSync(host("one.js"), "independent host change")
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        second.base,
        { "one.js": encoded("third") },
        undefined,
        { approve: approved },
      ),
    ).rejects.toThrow(/host base.*changed/)
    expect(readFileSync(host("one.js"), "utf8")).toBe("independent host change")
  })

  test("reconciles older sequential receipts when only the final staged bytes remain", async () => {
    const base = { "one.js": original("one.js", "before") }
    await reviewVmProjectWithApproval(
      root,
      workspace,
      base,
      { "one.js": encoded("first") },
      undefined,
      { approve: approved },
    )
    const installed = regularFile(host("one.js"))
    const interim = { "one.js": { ...installed, data: installed.data.toString("base64") } }
    const files = { "one.js": encoded("second") }
    await reviewVmProjectWithApproval(root, workspace, interim, files, undefined, {
      approve: approved,
    })
    const record = {
      version: 1 as const,
      project: workspace,
      identity: directoryIdentity(workspace),
      revision: "a".repeat(40),
      profile: "fixture",
      base,
      snapshot: { token: "583ac076-7196-4c56-8af8-099829254ff8", files, state: {}, sessions: [] },
    }
    const refreshed = reconcileVmProjectReceipts(
      root,
      workspace,
      path.join(root, "checkpoint.json"),
      record,
    )
    expect(refreshed.base["one.js"]?.data).toBe(files["one.js"])
    expect(refreshed.appliedReceipts).toHaveLength(2)
  })

  test("refuses a tampered committed receipt without changing the baseline", async () => {
    const base = { "one.js": original("one.js", "before") }
    const files = { "one.js": encoded("after") }
    await reviewVmProjectWithApproval(root, workspace, base, files, undefined, {
      approve: approved,
    })
    const [receipt] = readdirSync(root).filter((name) => name.startsWith("apply-receipt-"))
    const receiptPath = path.join(root, receipt!)
    const envelope = JSON.parse(readFileSync(receiptPath, "utf8"))
    envelope.record.files[0].after.revision = "0".repeat(64)
    writeFileSync(receiptPath, JSON.stringify(envelope))
    const record = {
      version: 1 as const,
      project: workspace,
      identity: directoryIdentity(workspace),
      revision: "a".repeat(40),
      profile: "fixture",
      base,
      snapshot: { token: "583ac076-7196-4c56-8af8-099829254ff8", files, state: {}, sessions: [] },
    }
    expect(() =>
      reconcileVmProjectReceipts(root, workspace, path.join(root, "checkpoint.json"), record),
    ).toThrow(/invalid VM apply receipt/)
    expect(record.base["one.js"].data).toBe(encoded("before"))
    expect(readFileSync(host("one.js"), "utf8")).toBe("after")
  })

  test("detects tampering with a receipt already used to refresh the baseline", async () => {
    const base = { "one.js": original("one.js", "before") }
    const files = { "one.js": encoded("after") }
    await reviewVmProjectWithApproval(root, workspace, base, files, undefined, {
      approve: approved,
    })
    const record = {
      version: 1 as const,
      project: workspace,
      identity: directoryIdentity(workspace),
      revision: "a".repeat(40),
      profile: "fixture",
      base,
      snapshot: { token: "583ac076-7196-4c56-8af8-099829254ff8", files, state: {}, sessions: [] },
    }
    const filename = path.join(root, "checkpoint.json")
    const refreshed = reconcileVmProjectReceipts(root, workspace, filename, record)
    const [receipt] = readdirSync(root).filter((name) => name.startsWith("apply-receipt-"))
    writeFileSync(path.join(root, receipt!), "{}")
    expect(() => reconcileVmProjectReceipts(root, workspace, filename, refreshed)).toThrow(
      /invalid VM apply receipt/,
    )
  })

  test("keeps a host change made after application and detects it in the next review", async () => {
    const base = { "one.js": original("one.js", "before") }
    const files = { "one.js": encoded("approved") }
    await reviewVmProjectWithApproval(root, workspace, base, files, undefined, {
      approve: approved,
    })
    writeFileSync(host("one.js"), "later host edit")
    const record = {
      version: 1 as const,
      project: workspace,
      identity: directoryIdentity(workspace),
      revision: "a".repeat(40),
      profile: "fixture",
      base,
      snapshot: { token: "583ac076-7196-4c56-8af8-099829254ff8", files, state: {}, sessions: [] },
    }
    const refreshed = reconcileVmProjectReceipts(
      root,
      workspace,
      path.join(root, "checkpoint.json"),
      record,
    )
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        refreshed.base,
        { "one.js": encoded("new proposal") },
        undefined,
        { approve: approved },
      ),
    ).rejects.toThrow(/host base.*changed/)
    expect(readFileSync(host("one.js"), "utf8")).toBe("later host edit")
  })

  test("refreshes the baseline only after an interrupted commit is recovered", async () => {
    const base = { "one.js": original("one.js", "before") }
    const files = { "one.js": encoded("after") }
    await expect(
      reviewVmProjectWithApproval(root, workspace, base, files, undefined, {
        approve: approved,
        checkpoint: (phase) => {
          if (phase === "committed") throw new Error("interrupted")
        },
      }),
    ).rejects.toThrow("interrupted")
    const record = {
      version: 1 as const,
      project: workspace,
      identity: directoryIdentity(workspace),
      revision: "a".repeat(40),
      profile: "fixture",
      base,
      snapshot: { token: "583ac076-7196-4c56-8af8-099829254ff8", files, state: {}, sessions: [] },
    }
    const filename = path.join(root, "checkpoint.json")
    expect(reconcileVmProjectReceipts(root, workspace, filename, record)).toBe(record)
    const installed = regularFile(host("one.js")).identity
    recoverVmProject(root, workspace)
    const refreshed = reconcileVmProjectReceipts(root, workspace, filename, record)
    expect(refreshed.base["one.js"]?.data).toBe(files["one.js"])
    expect(regularFile(host("one.js")).identity).toBe(installed)
    expect(reconcileVmProjectReceipts(root, workspace, filename, refreshed)).toEqual(refreshed)
  })

  test("refuses a host edit made during approval", async () => {
    const base = { "code.js": original("code.js", "before") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("proposal") },
        undefined,
        {
          approve: async () => {
            writeFileSync(host("code.js"), "host edit")
            return true
          },
        },
      ),
    ).rejects.toThrow(/host base.*changed/)
    expect(readFileSync(host("code.js"), "utf8")).toBe("host edit")
    expect(readdirSync(root)).toEqual([])
  })

  test("quarantines an unidentified early stage and recovers idempotently", async () => {
    const base = { "code.js": original("code.js", "before") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("after") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if ((phase as string) === "stage-created")
              throw new Error("interrupted after stage creation")
          },
        },
      ),
    ).rejects.toThrow("interrupted after stage creation")
    const [stage] = readdirSync(workspace).filter((name) => name.startsWith(".bashwink-vm-apply-"))
    expect(stage).toBeDefined()
    recoverVmProject(root, workspace)
    recoverVmProject(root, workspace)
    expect(readFileSync(host("code.js"), "utf8")).toBe("before")
    expect(readdirSync(workspace)).toContain(stage!)
    const receipt = readdirSync(root).find((name) => name.startsWith("apply-abandoned-"))
    expect(receipt).toBeDefined()
    expect(JSON.parse(readFileSync(path.join(root, receipt!), "utf8")).record.outcome).toBe(
      "abandoned-before-mutation",
    )
    expect(readdirSync(root)).not.toContain("apply.json")
  })

  test("recovers a journal interrupted before staging exists", async () => {
    const base = { "code.js": original("code.js", "before") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("after") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if (phase === "journaled") throw new Error("interrupted")
          },
        },
      ),
    ).rejects.toThrow("interrupted")
    expect(readdirSync(workspace)).toEqual(["code.js"])
    recoverVmProject(root, workspace)
    recoverVmProject(root, workspace)
    expect(readFileSync(host("code.js"), "utf8")).toBe("before")
    expect(readdirSync(root)).not.toContain("apply.json")
  })

  test("retries safely after the abandoned receipt is durable", async () => {
    const base = { "code.js": original("code.js", "before") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("after") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if (phase === "stage-created") throw new Error("interrupted")
          },
        },
      ),
    ).rejects.toThrow("interrupted")
    expect(() =>
      recoverVmProject(root, workspace, undefined, () => {
        throw new Error("receipt interruption")
      }),
    ).toThrow("receipt interruption")
    expect(readdirSync(root)).toContain("apply.json")
    expect(readdirSync(root).filter((name) => name.startsWith("apply-abandoned-"))).toHaveLength(1)
    recoverVmProject(root, workspace)
    expect(readdirSync(root)).not.toContain("apply.json")
    expect(readFileSync(host("code.js"), "utf8")).toBe("before")
  })

  test("retains an early journal if the host base changes before recovery", async () => {
    const base = { "code.js": original("code.js", "before") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("after") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if ((phase as string) === "stage-created") throw new Error("interrupted")
          },
        },
      ),
    ).rejects.toThrow("interrupted")
    writeFileSync(host("code.js"), "concurrent host change")
    expect(() => recoverVmProject(root, workspace)).toThrow(/host base.*changed/)
    expect(readFileSync(host("code.js"), "utf8")).toBe("concurrent host change")
    expect(readdirSync(root)).toContain("apply.json")
  })

  test("leaves an unexpected replacement of an early stage untouched", async () => {
    const base = { "code.js": original("code.js", "before") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("after") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if (phase === "stage-created") throw new Error("interrupted")
          },
        },
      ),
    ).rejects.toThrow("interrupted")
    const [stage] = readdirSync(workspace).filter((name) => name.startsWith(".bashwink-vm-apply-"))
    rmSync(host(stage!), { recursive: true })
    symlinkSync(host("code.js"), host(stage!))
    recoverVmProject(root, workspace)
    expect(readFileSync(host("code.js"), "utf8")).toBe("before")
    expect(readFileSync(host(stage!), "utf8")).toBe("before")
    expect(readdirSync(root)).not.toContain("apply.json")
  })

  test("protects tests and refuses symlink and hardlink destinations", async () => {
    const base = { "code.js": original("code.js", "outside") }
    const proposed = { ...base, "code.js": base["code.js"].data, "code.test.js": encoded("body") }
    await expect(
      reviewVmProjectWithApproval(root, workspace, base, proposed, undefined, {
        approve: approved,
      }),
    ).rejects.toThrow(/protected/)
    symlinkSync(host("code.js"), host("new.js"))
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": base["code.js"].data, "new.js": encoded("bad") },
        undefined,
        {
          approve: approved,
        },
      ),
    ).rejects.toThrow()
    linkSync(host("code.js"), host("alias.js"))
    await expect(
      reviewVmProjectWithApproval(root, workspace, base, { "code.js": encoded("bad") }, undefined, {
        approve: approved,
      }),
    ).rejects.toThrow()
    expect(readFileSync(host("code.js"), "utf8")).toBe("outside")
  })

  test("resumes an approved batch interrupted between atomic mutations", async () => {
    const base = {
      "a.js": original("a.js", "first"),
      "b.js": original("b.js", "second"),
      "c.js": original("c.js", "delete me"),
    }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        {
          "a.js": encoded("changed first"),
          "b.js": encoded("changed second"),
          "d.js": encoded("new"),
        },
        undefined,
        {
          approve: approved,
          checkpoint: (phase, filename) => {
            if (phase === "mutated" && filename === "a.js") throw new Error("interrupted")
          },
        },
      ),
    ).rejects.toThrow("interrupted")
    expect(readFileSync(host("a.js"), "utf8")).toBe("changed first")
    expect(readFileSync(host("b.js"), "utf8")).toBe("second")
    recoverVmProject(root, workspace)
    recoverVmProject(root, workspace)
    expect(readdirSync(workspace).sort()).toEqual(["a.js", "b.js", "d.js"])
    expect(readFileSync(host("b.js"), "utf8")).toBe("changed second")
    expect(readFileSync(host("d.js"), "utf8")).toBe("new")
  })

  test("reports partial progress when a later host file changes at the mutation boundary", async () => {
    const base = {
      "a.js": original("a.js", "first"),
      "b.js": original("b.js", "second"),
    }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        {
          "a.js": encoded("approved first"),
          "b.js": encoded("approved second"),
        },
        undefined,
        {
          approve: approved,
          checkpoint: (phase, filename) => {
            if (phase === "before-mutation" && filename === "b.js")
              writeFileSync(host("b.js"), "unapproved host edit")
          },
        },
      ),
    ).rejects.toThrow(/a\.js=applied, b\.js=uncertain/)
    expect(() => recoverVmProject(root, workspace)).toThrow(/a\.js=applied, b\.js=uncertain/)
    expect(readFileSync(host("a.js"), "utf8")).toBe("approved first")
    expect(readFileSync(host("b.js"), "utf8")).toBe("unapproved host edit")
  })

  test("keeps uncertain displaced and installed versions for inspection", async () => {
    const base = { "code.js": original("code.js", "before") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("approved") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if (phase === "mutated") writeFileSync(host("code.js"), "host edit of installed inode")
          },
        },
      ),
    ).rejects.toThrow(/code\.js=uncertain/)
    const [stage] = readdirSync(workspace).filter((name) => name.startsWith(".bashwink-vm-apply-"))
    expect(stage).toBeDefined()
    expect(readFileSync(host(stage! + "/entry-0"), "utf8")).toBe("before")
    expect(readFileSync(host("code.js"), "utf8")).toBe("host edit of installed inode")
    expect(() => recoverVmProject(root, workspace)).toThrow(/code\.js=uncertain/)
  })

  test("retains staging and host state if the journal is corrupt", async () => {
    const base = { "code.js": original("code.js", "original") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("approved") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if (phase === "prepared") throw new Error("halt after preparation")
          },
        },
      ),
    ).rejects.toThrow("halt after preparation")
    const journalPath = path.join(root, "apply.json")
    const record = JSON.parse(readFileSync(journalPath, "utf8"))
    record.record.phase = "committed"
    writeFileSync(journalPath, JSON.stringify(record))
    expect(() => recoverVmProject(root, workspace)).toThrow(/invalid VM apply journal/)
    expect(readFileSync(host("code.js"), "utf8")).toBe("original")
    expect(readdirSync(workspace)).toHaveLength(2)
    expect(readdirSync(root)).toEqual(["apply.json"])
  })

  test("retires verified entries if interruption follows the durable commit record", async () => {
    const base = { "code.js": original("code.js", "original") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("approved") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if (phase === "committed") throw new Error("halt before cleanup")
          },
        },
      ),
    ).rejects.toThrow("halt before cleanup")
    const receipt = readdirSync(root).find((name) => name.startsWith("apply-receipt-"))
    expect(receipt).toBeDefined()
    const durable = readFileSync(path.join(root, receipt!), "utf8")
    expect(JSON.parse(durable).record.outcome).toBe("committed")
    recoverVmProject(root, workspace)
    recoverVmProject(root, workspace)
    expect(readFileSync(host("code.js"), "utf8")).toBe("approved")
    expect(readdirSync(workspace)).toEqual(["code.js"])
    expect(readdirSync(root)).toEqual([receipt!])
    expect(readFileSync(path.join(root, receipt!), "utf8")).toBe(durable)
  })

  test("checks the project revision again after the approval wait", async () => {
    let revision = "original"
    const base = { "code.js": original("code.js", "original") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("approved") },
        undefined,
        {
          approve: async () => {
            revision = "changed"
            return true
          },
          assertProject: () => {
            if (revision !== "original") throw new Error("Git base revision changed")
          },
        },
      ),
    ).rejects.toThrow("Git base revision changed")
    expect(readFileSync(host("code.js"), "utf8")).toBe("original")
    expect(readdirSync(workspace)).toEqual(["code.js"])
    expect(readdirSync(root)).toEqual([])
  })

  test("atomically restores a concurrent regular host edit displaced by a swap", async () => {
    const base = { "code.js": original("code.js", "original") }
    await expect(
      reviewVmProjectWithApproval(
        root,
        workspace,
        base,
        { "code.js": encoded("approved") },
        undefined,
        {
          approve: approved,
          checkpoint: (phase) => {
            if (phase === "checked") writeFileSync(host("code.js"), "concurrent host edit")
          },
        },
      ),
    ).rejects.toThrow(/Restored the concurrent host edit/)
    const [stage] = readdirSync(workspace).filter((name) => name.startsWith(".bashwink-vm-apply-"))
    expect(readFileSync(host("code.js"), "utf8")).toBe("concurrent host edit")
    expect(readFileSync(host(stage! + "/entry-0"), "utf8")).toBe("approved")
    expect(readdirSync(root)).toEqual(["apply.json"])
  })
})
