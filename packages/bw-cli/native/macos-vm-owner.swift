import Darwin
import Foundation
import Virtualization

guard CommandLine.arguments.count >= 4, VZVirtualMachine.isSupported else {
    exit(3)
}
let files = CommandLine.arguments[1...3].map { URL(fileURLWithPath: $0) }
let options = Array(CommandLine.arguments.dropFirst(4))
let hostTerminal = options.contains("--host-terminal")
let serialInput = options.contains("--serial-input")
guard !(hostTerminal && serialInput) else { exit(3) }
let deadlines = options.filter { $0.hasPrefix("--timeout-ms=") }
let leaseOptions = options.filter {
    $0 != "--serial-input" && $0 != "--host-terminal" && !$0.hasPrefix("--timeout-ms=")
}
guard leaseOptions.count <= 1, deadlines.count <= 1, !hostTerminal || leaseOptions.isEmpty else {
    exit(3)
}
let timeoutMs = deadlines.first.flatMap { Int($0.dropFirst("--timeout-ms=".count)) }
if !deadlines.isEmpty {
    guard let timeoutMs, (1...120_000).contains(timeoutMs) else { exit(3) }
}
let lease = hostTerminal ? STDIN_FILENO : leaseOptions.first.flatMap(Int32.init)
if let lease {
    var info = stat()
    // Bun may supply its stdin pipe as a Unix socket pair. Neither endpoint
    // is exposed to the guest, and terminal input uses a different descriptor.
    guard (hostTerminal || lease > STDERR_FILENO), fstat(lease, &info) == 0,
        ((info.st_mode & S_IFMT) == S_IFIFO || (hostTerminal && (info.st_mode & S_IFMT) == S_IFSOCK)),
        hostTerminal || fcntl(lease, F_GETFL) & O_ACCMODE == O_RDONLY,
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
let terminal = hostTerminal ? open("/dev/tty", O_RDWR | O_NOCTTY | O_CLOEXEC) : -1
guard !hostTerminal || terminal >= 0 else { exit(3) }
var savedTerminal = termios()
guard !hostTerminal || tcgetattr(terminal, &savedTerminal) == 0 else { exit(3) }
let terminalInput = hostTerminal ? Pipe() : nil
let terminalOutput = hostTerminal ? Pipe() : nil
console.attachment = VZFileHandleSerialPortAttachment(
    fileHandleForReading: terminalInput?.fileHandleForReading ?? (serialInput ? .standardInput : nil),
    fileHandleForWriting: terminalOutput?.fileHandleForWriting ?? .standardOutput)
let attachment = try VZDiskImageStorageDeviceAttachment(url: files[2], readOnly: false)
let config = VZVirtualMachineConfiguration()
config.bootLoader = boot
config.cpuCount = 2
config.memorySize = ((hostTerminal || serialInput) ? 1536 : 512) * 1024 * 1024
config.serialPorts = [console]
config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
config.networkDevices = []
config.directorySharingDevices = []
try config.validate()
let vm = VZVirtualMachine(configuration: config)
var stopExit: Int32?
var stopping = false
func finish(_ code: Int32) -> Never {
    if hostTerminal { _ = tcsetattr(terminal, TCSANOW, &savedTerminal) }
    exit(code)
}
final class GuestLifecycle: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        guard virtualMachine.state == .stopped else { finish(6) }
        print("HOST_VM_STOPPED")
        finish(stopExit ?? 0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("VM stopped with error: \(error)\n".utf8))
        finish(5)
    }
}
let lifecycle = GuestLifecycle()
vm.delegate = lifecycle
func requestStop(_ exitCode: Int32) {
    if stopExit == nil { stopExit = exitCode }
    guard vm.canStop, !stopping, let stopExit else { return }
    stopping = true
    vm.stop { error in
        if let error {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            finish(5)
        }
        guard vm.state == .stopped else { finish(6) }
        print("HOST_VM_STOPPED")
        finish(stopExit)
    }
}
let signals: [(Int32, Int32)] = [(SIGUSR1, 0), (SIGINT, 130), (SIGTERM, 143), (SIGHUP, 129)]
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
let tty = hostTerminal ? FileHandle(fileDescriptor: terminal, closeOnDealloc: true) : nil
if let tty, let terminalInput, let terminalOutput {
    var raw = savedTerminal
    cfmakeraw(&raw)
    guard tcsetattr(terminal, TCSANOW, &raw) == 0 else { finish(3) }
    tty.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty {
            handle.readabilityHandler = nil
            DispatchQueue.main.async { requestStop(129) }
        } else {
            try? terminalInput.fileHandleForWriting.write(contentsOf: data)
        }
    }
    terminalOutput.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty {
            handle.readabilityHandler = nil
        } else {
            try? FileHandle.standardOutput.write(contentsOf: data)
        }
    }
}
vm.start { result in
    if case let .failure(error) = result {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        finish(7)
    }
    if let stopExit { requestStop(stopExit) }
}
dispatchMain()
