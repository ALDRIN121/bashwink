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
cp /opt/opencode-fixture.json /workspace/opencode.json
dd if=/dev/vda bs=512 count=1 2>/dev/null | tr -d '\000' > /workspace/task.txt
if test ! -s /workspace/task.txt; then
    printf 'Original VM fixture\n' > /workspace/task.txt
fi
echo "BW_VM_INPUT $(sha256sum /workspace/task.txt)"
mkfifo /run/bw-heartbeats
chmod 622 /run/bw-heartbeats
(
    while IFS= read -r count; do
        case "$count" in ''|*[!0-9]*) continue ;; esac
        test "${#count}" -le 6 || continue
        printf '%s\n' "$count" | dd of=/dev/vda bs=512 seek=2 conv=sync,fsync,notrunc 2>/dev/null
    done <> /run/bw-heartbeats
) &
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
stty -F /dev/hvc0 rows 34 cols 120
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
