import Darwin
import Foundation
import Virtualization

private struct RelayEndpoint {
    private let address: sockaddr_un
    private let path: String
    private let device: dev_t
    private let inode: ino_t

    init?(path: String, disk: URL) {
        let cwd = FileManager.default.currentDirectoryPath
        var directory = stat()
        var info = stat()
        var address = sockaddr_un()
        let name = path.utf8CString
        guard path == cwd + "/relay.sock", disk.deletingLastPathComponent().path == cwd,
            stat(".", &directory) == 0, directory.st_uid == geteuid(), directory.st_mode & 0o077 == 0,
            lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFSOCK,
            info.st_uid == geteuid(), info.st_mode & 0o077 == 0,
            name.count <= MemoryLayout.size(ofValue: address.sun_path)
        else { return nil }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { bytes in
            name.withUnsafeBytes { bytes.copyBytes(from: $0) }
        }
        self.path = path
        self.address = address
        self.device = info.st_dev
        self.inode = info.st_ino
    }

    func connect() -> Int32? {
        var info = stat()
        guard lstat(path, &info) == 0, info.st_dev == device, info.st_ino == inode,
            (info.st_mode & S_IFMT) == S_IFSOCK, info.st_uid == geteuid(), info.st_mode & 0o077 == 0
        else { return nil }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return nil }
        var transferred = false
        defer { if !transferred { close(descriptor) } }
        guard prepareRelayDescriptor(descriptor) else { return nil }
        var endpoint = address
        let result = withUnsafePointer(to: &endpoint) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(address.sun_len))
            }
        }
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard result == 0, getpeereid(descriptor, &uid, &gid) == 0, uid == geteuid() else { return nil }
        transferred = true
        return descriptor
    }
}

private func prepareRelayDescriptor(_ descriptor: Int32) -> Bool {
    let flags = fcntl(descriptor, F_GETFL)
    var enabled: Int32 = 1
    return flags >= 0 && fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0
        && fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0
        && setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size)) == 0
}

private struct SocketTransfer {
    private var bytes = [UInt8](repeating: 0, count: 16 * 1024)
    private var length = 0
    private var offset = 0
    private(set) var ended = false
    var canWrite: Bool { offset < length }
    var canRead: Bool { !canWrite && !ended }

    mutating func read(from source: Int32, to destination: Int32) -> Bool {
        let count = bytes.withUnsafeMutableBytes { Darwin.read(source, $0.baseAddress, $0.count) }
        if count < 0 { return errno == EINTR || errno == EAGAIN }
        if count == 0 {
            ended = true
            _ = shutdown(destination, SHUT_WR)
        }
        offset = 0
        length = count
        return true
    }

    mutating func write(to destination: Int32) -> Bool {
        let remaining = length - offset
        let count = bytes.withUnsafeBytes {
            Darwin.write(destination, $0.baseAddress?.advanced(by: offset), remaining)
        }
        if count < 0 { return errno == EINTR || errno == EAGAIN }
        guard count > 0 else { return false }
        offset += count
        return true
    }
}

private func forwardSocketBytes(guest: Int32, broker: Int32) {
    var toBroker = SocketTransfer()
    var toGuest = SocketTransfer()
    while !toBroker.ended || !toGuest.ended {
        let guestEvents = Int16((toBroker.canRead ? POLLIN : 0) | (toGuest.canWrite ? POLLOUT : 0))
        let brokerEvents = Int16((toGuest.canRead ? POLLIN : 0) | (toBroker.canWrite ? POLLOUT : 0))
        var endpoints = [
            pollfd(fd: guestEvents == 0 ? -1 : guest, events: guestEvents, revents: 0),
            pollfd(fd: brokerEvents == 0 ? -1 : broker, events: brokerEvents, revents: 0),
        ]
        if poll(&endpoints, nfds_t(endpoints.count), -1) < 0 {
            if errno == EINTR { continue }
            return
        }
        let guestReady = Int32(endpoints[0].revents)
        let brokerReady = Int32(endpoints[1].revents)
        if (guestReady | brokerReady) & (POLLERR | POLLNVAL) != 0 { return }
        if toBroker.canWrite && brokerReady & (POLLOUT | POLLHUP) != 0,
            !toBroker.write(to: broker) { return }
        if toGuest.canWrite && guestReady & (POLLOUT | POLLHUP) != 0,
            !toGuest.write(to: guest) { return }
        if toBroker.canRead && guestReady & (POLLIN | POLLHUP) != 0,
            !toBroker.read(from: guest, to: broker) { return }
        if toGuest.canRead && brokerReady & (POLLIN | POLLHUP) != 0,
            !toGuest.read(from: broker, to: guest) { return }
    }
}

private final class ProviderSocketRelay: NSObject, VZVirtioSocketListenerDelegate {
    static let port: UInt32 = 8118
    private let socketDevice: VZVirtioSocketDevice
    private let listener = VZVirtioSocketListener()
    private let endpoint: RelayEndpoint
    private var running = true
    private var streams: [Int32: (VZVirtioSocketConnection, Int32)] = [:]

    init(socketDevice: VZVirtioSocketDevice, endpoint: RelayEndpoint) {
        self.socketDevice = socketDevice
        self.endpoint = endpoint
        super.init()
        listener.delegate = self
        socketDevice.setSocketListener(listener, forPort: Self.port)
    }

    func listener(
        _ listener: VZVirtioSocketListener,
        shouldAcceptNewConnection connection: VZVirtioSocketConnection,
        from socketDevice: VZVirtioSocketDevice
    ) -> Bool {
        guard running, socketDevice === self.socketDevice, connection.destinationPort == Self.port,
            streams.count < 4
        else { return false }
        let guest = fcntl(connection.fileDescriptor, F_DUPFD_CLOEXEC, 0)
        guard guest >= 0 else { return false }
        guard prepareRelayDescriptor(guest), let broker = endpoint.connect() else {
            close(guest)
            return false
        }
        // Keep the VZ connection alive, and give the worker a descriptor that remains
        // valid even if Virtualization closes its own descriptor while stopping.
        streams[guest] = (connection, broker)
        DispatchQueue.global(qos: .utility).async {
            forwardSocketBytes(guest: guest, broker: broker)
            DispatchQueue.main.async {
                self.streams.removeValue(forKey: guest)?.0.close()
                close(guest)
                close(broker)
            }
        }
        return true
    }

    func stop() {
        guard running else { return }
        running = false
        socketDevice.removeSocketListener(forPort: Self.port)
        for (guest, (_, broker)) in streams {
            // Wake the worker before it releases either descriptor. Process exit also closes both.
            _ = shutdown(guest, SHUT_RDWR)
            _ = shutdown(broker, SHUT_RDWR)
        }
    }
}

guard CommandLine.arguments.count >= 4, VZVirtualMachine.isSupported else {
    exit(3)
}
let files = CommandLine.arguments[1...3].map { URL(fileURLWithPath: $0) }
let options = Array(CommandLine.arguments.dropFirst(4))
let hostTerminal = options.contains("--host-terminal")
let serialInput = options.contains("--serial-input")
guard !(hostTerminal && serialInput) else { exit(3) }
let deadlines = options.filter { $0.hasPrefix("--timeout-ms=") }
let stageLocks = options.filter { $0.hasPrefix("--stage-lock-fd=") }
let relayOptions = options.filter { $0.hasPrefix("--relay-socket=") }
let leaseOptions = options.filter {
    $0 != "--serial-input" && $0 != "--host-terminal" && !$0.hasPrefix("--timeout-ms=")
        && !$0.hasPrefix("--stage-lock-fd=") && !$0.hasPrefix("--relay-socket=")
}
guard leaseOptions.count <= 1, deadlines.count <= 1, relayOptions.count <= 1,
    !hostTerminal || leaseOptions.isEmpty
else {
    exit(3)
}
if !stageLocks.isEmpty {
    var info = stat()
    guard stageLocks == ["--stage-lock-fd=3"], hostTerminal,
        fstat(3, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
        info.st_uid == getuid(), info.st_mode & 0o077 == 0,
        fcntl(3, F_SETFD, FD_CLOEXEC) == 0
    else { exit(3) }
    // Keep the launcher's inherited flock reference until the VM owner exits.
}
let timeoutMs = deadlines.first.flatMap { Int($0.dropFirst("--timeout-ms=".count)) }
if !deadlines.isEmpty {
    guard let timeoutMs, (1...3_600_000).contains(timeoutMs) else { exit(3) }
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
private let relayEndpoint = relayOptions.first.flatMap {
    RelayEndpoint(path: String($0.dropFirst("--relay-socket=".count)), disk: files[2])
}
if !relayOptions.isEmpty && (lease == nil || relayEndpoint == nil) {
    FileHandle.standardError.write(Data("VM provider relay configuration rejected\n".utf8))
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
if relayEndpoint != nil {
    config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
}
try config.validate()
let vm = VZVirtualMachine(configuration: config)
private let relay: ProviderSocketRelay? = relayEndpoint.map { endpoint in
    guard let socketDevice = vm.socketDevices.first as? VZVirtioSocketDevice else { exit(3) }
    return ProviderSocketRelay(socketDevice: socketDevice, endpoint: endpoint)
}
var stopExit: Int32?
var stopping = false
func finish(_ code: Int32) -> Never {
    relay?.stop()
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
    relay?.stop()
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
