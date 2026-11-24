#!/bin/sh
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
test "$(ls /sys/class/net)" = lo
mkdir /workspace /state
stty -F /dev/hvc0 rows 34 cols 120
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

if test "$(cat /sys/class/block/vda/size)" = 81920; then
    limit=33554432
    chmod 600 /dev/vda
    project_size "$(dd if=/dev/vda bs=512 count=1 2>/dev/null | tr -d '\000')"
    dd if=/dev/vda bs=4096 skip=1 count="$(((size + 4095) / 4096))" 2>/dev/null \
        | head -c "$size" > /run/bw-project-input
    test "$(wc -c < /run/bw-project-input)" -eq "$size"
    # Invalidate the input header before running any workspace code. Publish only after the
    # new payload reaches the disk, with the status sector written by the exit trap.
    dd if=/dev/zero of=/dev/vda bs=512 count=1 conv=fsync,notrunc 2>/dev/null
    chown nobody:nobody /workspace /state
    selection=$(project_guest restore)
    if test "$selection" = verify; then
        operation=verify
    else
        printf '%s\n' "$selection" > /run/bw-project-session
        setsid sh -c 'exec </dev/hvc0 >/dev/hvc0 2>&1; exec su -s /bin/sh -c /opt/run-user nobody'
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
fi

cp /opt/opencode-fixture.json /workspace/opencode.json
dd if=/dev/vda bs=512 count=1 2>/dev/null | tr -d '\000' > /workspace/task.txt
if test ! -s /workspace/task.txt; then
    printf 'Original VM fixture\n' > /workspace/task.txt
fi
echo "BW_VM_INPUT $(sha256sum /workspace/task.txt)"
cat > /workspace/check.sh <<'CHECK'
#!/bin/sh
set -eu
test "$(cat task.txt)" = "VM fixture edit"
test ! -r '@CANARY@'
if (printf 'unexpected write\n' > '@CANARY@') 2>/dev/null; then
    exit 1
fi
printf 'VM shell ran\n' > shell-result.txt
setsid sh -c '
    for tick in $(seq 1 120); do
        printf "%s\n" "$tick" > /run/bw-heartbeats
        sleep 0.2
    done
' < /dev/null > /dev/null 2>&1 &
CHECK
chown -R nobody:nobody /workspace /state
setsid sh -c 'exec </dev/hvc0 >/dev/hvc0 2>&1; exec su -s /bin/sh -c /opt/run-user nobody'
if test ! -f /workspace/shell-result.txt; then
    exit 0
fi
test "$(cat /workspace/task.txt)" = "VM fixture edit"
test "$(cat /workspace/shell-result.txt)" = "VM shell ran"
test ! -e '@CANARY@'
stage_entry() {
    hash=$(sha256sum "/workspace/$1")
    printf '"%s":{"data":"%s","sha256":"%s"}' "$1" \
        "$(base64 < "/workspace/$1" | tr -d '\n')" "${hash%% *}"
}
export_record=$(printf '{"version":1,"files":{%s,%s}}' \
    "$(stage_entry task.txt)" "$(stage_entry shell-result.txt)")
test "${#export_record}" -le 512
printf '%s' "$export_record" | dd of=/dev/vda bs=512 conv=sync,fsync,notrunc 2>/dev/null
echo BW_VM_OPENCODE_PASS
