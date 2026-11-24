# v0.1.0-alpha.1 — performance and resource use

All numbers are measurements, not targets. No performance goal is set for this alpha.

## Test machine

MacBook Air (M1, 8 cores: 4 performance + 4 efficiency), **8 GB** RAM, macOS 27.0.1 (26A434),
APFS internal SSD. Normal desktop load: other applications were running. This is the
engineering machine, **not a clean host**, and it is a low-memory, fanless configuration. One
machine, small sample sizes, no statistics.

Raw data: [first-run-measurements.json](evidence/performance/first-run-measurements.json)
(release CLI, real PTY, scrubbed environment, candidate archive) and
[vm-perf-synthetic.json](evidence/performance/vm-perf-synthetic.json) (release VM image behind a
synthetic upstream, so no provider latency is included).

## Measurements

| Measure | Result | How measured |
| --- | --- | --- |
| Archive size | 333,567,141 bytes (318 MiB) | `ls` of the `.tar.gz` |
| Installed disk use | 713,992,249 bytes (681 MiB) | sum of file sizes under the install prefix |
| Archive extraction | 3.1 s | `tarfile` extract, one run |
| Installation (`install.sh`, includes two full-file SHA-256 verifications) | 5.7 s (5.8 s and 6.6 s in two earlier runs) | wall clock |
| Launch to workspace-approval prompt (includes asset hashing and provider setup) | 0.41 s | wall clock, one run |
| Cold VM start: approval answered to TUI visible | 5.35 s (4.78 s in an earlier run) | wall clock to the text `Ask anything` |
| Repeat launches to TUI (assets in the page cache, project already approved) | 5.36, 4.25, 4.38 s; later 4.78, 4.28, 4.68 s | wall clock |
| Session resume (`--continue`) to TUI | 4.41, 4.46, 4.40 s | wall clock, synthetic upstream |
| Scripted five-step coding turn (three file writes, a delete, `bun test`) | 26.3 s | includes synthetic upstream delays and approvals; **not** a model-latency figure |
| Reviewed export: preview shown | 0.19 s | `sandbox vm-review` start to `Type apply` |
| Reviewed export: apply of four files (add, modify, delete) | 0.15 s | `apply` typed to exit |
| Protected-test verification in a fresh VM | 2.05 s | `sandbox vm-verify` start to result |
| Whole-workload resident memory, peak sampled | 723 MiB RSS peak (706 MiB); 852,272 KiB in the first-run harness | `ps rss`, summed over launcher + VM owner + Virtualization helper, 1 Hz |
| Whole-workload physical footprint | about 870 to 937 MiB (idle at the TUI to peak during the turn) | `footprint`, summed over the same processes |
| Peak CPU of the whole workload | 52% and 129% of one core (boot is the peak) | CPU-time deltas, 1 Hz, summed over the same processes |
| VM configuration | 2 virtual CPUs, 1,536 MiB guest memory | from the VM owner source |

"Whole workload" means all three processes: the launcher (`bun`), the VM owner (`vm-owner`, about
10 MiB) and the `com.apple.Virtualization.VirtualMachine` helper process that actually holds the
guest memory (about 650 to 700 MiB RSS). Sampling only the VM owner, as an earlier measurement
did, reports about 8 MiB and is not a measure of the workload.

## Not measured

- **Time to first token**: requires a live provider. Not measured; `NOT_RUN`.
- Reviewed export and session recovery latency **with a live-provider session** (the figures
  above use a synthetic upstream and a four-file project).
- Peak memory during a long live session, and anything on a larger project (the supported
  profile is at most 64 files of 256 KiB).
- Performance on a clean host, on a machine with more or less memory, or on another macOS build.
- Behaviour under memory pressure on the 8 GB machine, including whether the host swaps while the
  VM and a browser are both open.
- "Cold" start in the sense of an empty host page cache. The VM always boots from scratch; the
  first launch after install (above) is the closest observation, and a purge of the page cache
  was not possible without administrator rights.

## Observations that affect use

- A session costs roughly 0.9 GB of the host's memory. On an 8 GB machine that is noticeable.
- Boot to a usable UI is about 4 to 5 seconds, so there is no meaningful difference between the
  first and later launches on this machine.
