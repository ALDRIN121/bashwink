import Darwin
import Foundation
import Virtualization

// Lab entry point. All arguments are disposable inputs created by vm-boundary.py.
guard CommandLine.arguments.count == 4, VZVirtualMachine.isSupported else {
    exit(3)
}
let files = CommandLine.arguments.dropFirst().map { URL(fileURLWithPath: $0) }
let lock = open(files[2].path + ".lock", O_RDWR | O_NOFOLLOW)
guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
    exit(8)
}
let boot = VZLinuxBootLoader(kernelURL: files[0])
boot.initialRamdiskURL = files[1]
boot.commandLine = "console=hvc0 rdinit=/init quiet panic=-1"
let console = VZVirtioConsoleDeviceSerialPortConfiguration()
console.attachment = VZFileHandleSerialPortAttachment(
    fileHandleForReading: nil, fileHandleForWriting: .standardOutput)
let attachment = try VZDiskImageStorageDeviceAttachment(url: files[2], readOnly: false)
let config = VZVirtualMachineConfiguration()
config.bootLoader = boot
config.cpuCount = 2
config.memorySize = 512 * 1024 * 1024
config.serialPorts = [console]
config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
config.networkDevices = []
config.directorySharingDevices = []
try config.validate()
let vm = VZVirtualMachine(configuration: config)
let stopRequest = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
signal(SIGUSR1, SIG_IGN)
stopRequest.setEventHandler {
    guard vm.canStop else { exit(4) }
    vm.stop { error in
        if let error {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(5)
        }
        guard vm.state == .stopped else { exit(6) }
        print("HOST_VM_STOPPED")
        exit(0)
    }
}
stopRequest.resume()
vm.start { result in
    if case let .failure(error) = result {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(7)
    }
}
dispatchMain()
