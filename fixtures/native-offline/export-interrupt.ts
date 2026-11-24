import { exportNativeStage } from "../../packages/bw-cli/src/native-export.js"

await exportNativeStage(process.argv[2]!, (phase) => {
  if (phase === process.argv[3]) process.kill(process.pid, "SIGKILL")
})
