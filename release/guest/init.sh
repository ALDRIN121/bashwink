#!/bin/sh
# Bashwink release guest init (PID 1). Project sessions only: there is no mock model, no
# fixture canary and no network. Any other disk layout is refused.
set -eu
finish() {
    code=$?
    if test -b /dev/vda; then
        printf 'BWVM1 %s\n' "$code" | dd of=/dev/vda bs=512 seek=1 conv=sync,fsync,notrunc 2>/dev/null
    fi
    poweroff -f
}
trap finish EXIT
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts
mount -t devpts devpts /dev/pts
insmod /virtio_blk.ko
ip link set lo up
# The VM is configured with no network device. Refuse to run if one ever appears.
test "$(ls /sys/class/net)" = lo
mkdir /workspace /state
stty -F /dev/hvc0 rows 34 cols 120
# Diagnostic channel: an unprivileged writer may record a bounded counter in sector 2 of the
# stage disk, so a host observer can tell whether a guest process is still alive.
mkfifo /run/bw-heartbeats
chmod 622 /run/bw-heartbeats
(
    while IFS= read -r count; do
        case "$count" in ''|*[!0-9]*) continue ;; esac
        test "${#count}" -le 6 || continue
        printf '%s\n' "$count" | dd of=/dev/vda bs=512 seek=2 conv=sync,fsync,notrunc 2>/dev/null
    done <> /run/bw-heartbeats
) &

project_size() {
    case "$1" in 'BWPROJECT1 '*) size=${1#BWPROJECT1 } ;; *) return 1 ;; esac
    case "$size" in ''|0*|*[!0-9]*) return 1 ;; esac
    test "${#size}" -le 8 && test "$size" -le "$limit"
}

project_guest() {
    su -s /bin/sh -c "test ! -r /dev/vda && test ! -w /dev/vda && exec /opt/bun /opt/vm-project-guest.ts $1" nobody \
        < /run/bw-project-input
}

start_relay() {
    insmod /opt/bw-vsock/vsock.ko &&
        insmod /opt/bw-vsock/vmw_vsock_virtio_transport_common.ko &&
        insmod /opt/bw-vsock/vmw_vsock_virtio_transport.ko || return 1
    # Probe the VM-local hypervisor endpoint without issuing an HTTP request.
    timeout 3 su -s /bin/sh -c 'exec /usr/bin/socat -u /dev/null VSOCK-CONNECT:2:8118' nobody || return 1
    su -s /bin/sh -c 'exec /usr/bin/socat -T100 TCP4-LISTEN:8118,bind=127.0.0.1,reuseaddr,fork,max-children=8 VSOCK-CONNECT:2:8118,connect-timeout=3' nobody </dev/null &
    relay_pid=$!
    for attempt in 1 2 3 4 5; do
        kill -0 "$relay_pid" 2>/dev/null || return 1
        # 0100007F:1FB6 is 127.0.0.1:8118 in /proc/net/tcp and 0A is LISTEN.
        awk '$2 == "0100007F:1FB6" && $4 == "0A" { ready=1 } END { exit !ready }' /proc/net/tcp && return 0
        sleep 0.1
    done
    return 1
}

test "$(cat /sys/class/block/vda/size)" = 81920
limit=33554432
chmod 600 /dev/vda
project_size "$(dd if=/dev/vda bs=512 count=1 2>/dev/null | tr -d '\000')"
(umask 077; dd if=/dev/vda bs=4096 skip=1 count="$(((size + 4095) / 4096))" 2>/dev/null \
    | head -c "$size" > /run/bw-project-input)
test "$(wc -c < /run/bw-project-input)" -eq "$size"
# Invalidate the input header before running any workspace code. Publish only after the
# new payload reaches the disk, with the status sector written by the exit trap.
dd if=/dev/zero of=/dev/vda bs=512 count=1 conv=fsync,notrunc 2>/dev/null
chown nobody:nobody /workspace /state
selection=$(project_guest restore)
if test "$selection" = verify; then
    operation=verify
else
    if ! test -f /state/bw-relay.json || ! start_relay; then
        echo "Bashwink guest model relay unavailable" >&2
        exit 1
    fi
    printf '%s\n' "$selection" > /run/bw-project-session
    status=0
    setsid sh -c 'exec </dev/hvc0 >/dev/hvc0 2>&1; exec su -s /bin/sh -c /opt/run-user nobody' || status=$?
    # 124 is the session time limit. The work is saved like a normal exit, and the user is told.
    if test "$status" -eq 124; then
        echo "Bashwink: the session time limit was reached. Your work is saved; resume with: bashwink --continue" > /dev/hvc0
    elif test "$status" -ne 0; then
        exit "$status"
    fi
    operation=snapshot
fi
# The destination belongs to init. Guest output can reach it only through this bounded pipe.
project_guest "$operation" | head -c "$((4096 + limit + 1))" > /run/bw-project-output
project_size "$(dd if=/run/bw-project-output bs=512 count=1 2>/dev/null | tr -d '\000')"
test "$(wc -c < /run/bw-project-output)" -eq "$((4096 + size))"
dd if=/run/bw-project-output of=/dev/vda bs=4096 skip=1 seek=1 conv=sync,fsync,notrunc 2>/dev/null
dd if=/run/bw-project-output of=/dev/vda bs=512 count=1 conv=fsync,notrunc 2>/dev/null
echo BW_VM_PROJECT_PASS
exit 0
