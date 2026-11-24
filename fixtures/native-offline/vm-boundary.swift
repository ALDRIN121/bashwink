import Darwin
import Foundation
import Virtualization

// Lab entry point. All arguments are disposable inputs created by vm-boundary.py.
guard CommandLine.arguments.count >= 4, VZVirtualMachine.isSupported else {
    exit(3)
}
let files = CommandLine.arguments[1...3].map { URL(fileURLWithPath: $0) }
let options = Array(CommandLine.arguments.dropFirst(4))
let interactive = options.contains("--serial-input")
let deadlines = options.filter { $0.hasPrefix("--timeout-ms=") }
let leaseOptions = options.filter { $0 != "--serial-input" && !$0.hasPrefix("--timeout-ms=") }
guard leaseOptions.count <= 1, deadlines.count <= 1 else { exit(3) }
let timeoutMs = deadlines.first.flatMap { Int($0.dropFirst("--timeout-ms=".count)) }
if !deadlines.isEmpty {
    guard let timeoutMs, (1...120_000).contains(timeoutMs) else { exit(3) }
}
let lease = leaseOptions.first.flatMap(Int32.init)
if let lease {
    var info = stat()
    guard lease > STDERR_FILENO, fstat(lease, &info) == 0,
        (info.st_mode & S_IFMT) == S_IFIFO,
        fcntl(lease, F_GETFL) & O_ACCMODE == O_RDONLY,
        fcntl(lease, F_SETFD, FD_CLOEXEC) == 0
    else { exit(3) }
} else if !leaseOptions.isEmpty {
    exit(3)
}
let lock = open(files[2].path + ".lock", O_RDWR | O_NOFOLLOW)
guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
    exit(8)
}
let boot = VZLinuxBootLoader(kernelURL: files[0])
boot.initialRamdiskURL = files[1]
boot.commandLine = "console=hvc0 rdinit=/init quiet panic=-1"
let console = VZVirtioConsoleDeviceSerialPortConfiguration()
console.attachment = VZFileHandleSerialPortAttachment(
    fileHandleForReading: interactive ? .standardInput : nil, fileHandleForWriting: .standardOutput)
let attachment = try VZDiskImageStorageDeviceAttachment(url: files[2], readOnly: false)
let config = VZVirtualMachineConfiguration()
config.bootLoader = boot
config.cpuCount = 2
config.memorySize = (interactive ? 1536 : 512) * 1024 * 1024
config.serialPorts = [console]
config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
config.networkDevices = []
config.directorySharingDevices = []
try config.validate()
let vm = VZVirtualMachine(configuration: config)
var stopExit: Int32?
var stopping = false
func requestStop(_ exitCode: Int32) {
    if stopExit == nil { stopExit = exitCode }
    guard vm.canStop, !stopping, let stopExit else { return }
    stopping = true
    vm.stop { error in
        if let error {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(5)
        }
        guard vm.state == .stopped else { exit(6) }
        print("HOST_VM_STOPPED")
        exit(stopExit)
    }
}
let signals: [(Int32, Int32)] = [(SIGUSR1, 0), (SIGINT, 130), (SIGTERM, 143)]
let stopRequests = signals.map { signum, exitCode in
    let source = DispatchSource.makeSignalSource(signal: signum, queue: .main)
    signal(signum, SIG_IGN)
    source.setEventHandler { requestStop(exitCode) }
    source.resume()
    return source
}
let timer = timeoutMs.map { duration in
    let source = DispatchSource.makeTimerSource(queue: .main)
    source.schedule(deadline: .now() + .milliseconds(duration))
    source.setEventHandler { requestStop(124) }
    source.resume()
    return source
}
let leaseSource = lease.map { descriptor in
    let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: .main)
    // This pipe carries no data. Closure or unexpected bytes end the owner's workload.
    source.setEventHandler {
        source.cancel()
        requestStop(0)
    }
    source.setCancelHandler { close(descriptor) }
    source.resume()
    return source
}
vm.start { result in
    if case let .failure(error) = result {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(7)
    }
    if let stopExit { requestStop(stopExit) }
}
dispatchMain()
