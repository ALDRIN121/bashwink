// Disposable fault fixture. The installed CLI uses the same journal and recovery implementation.
import { createInterface } from "node:readline/promises"
import { assertVmProjectRevision, openVmProject } from "../../packages/bw-cli/src/vm-project.js"
import { reviewVmProjectWithApproval } from "../../packages/bw-cli/src/vm-project-apply.js"

const [stopAt, ...selected] = process.argv.slice(2)
const project = openVmProject()
try {
  const snapshot = project.record.snapshot
  if (!snapshot) throw new Error("no disposable VM checkpoint")
  await reviewVmProjectWithApproval(
    project.root,
    project.project,
    project.record.base,
    snapshot.files,
    selected,
    {
      assertProject: () => assertVmProjectRevision(project),
      async approve(diff) {
        process.stdout.write(diff)
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        try {
          return (await prompt.question("Type apply to apply the selected changes: ")) === "apply"
        } finally {
          prompt.close()
        }
      },
      checkpoint(phase) {
        if (phase === stopAt) process.kill(process.pid, "SIGKILL")
      },
    },
  )
} finally {
  project.lifetime.close()
}
