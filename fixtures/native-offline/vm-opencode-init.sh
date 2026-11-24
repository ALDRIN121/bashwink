#!/bin/sh
set -eu
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
printf 'Original VM fixture\n' > /workspace/task.txt
cat > /workspace/check.sh <<'CHECK'
#!/bin/sh
set -eu
test "$(cat task.txt)" = "VM fixture edit"
test ! -r '@CANARY@'
if (printf 'unexpected write\n' > '@CANARY@') 2>/dev/null; then
    exit 1
fi
printf 'VM shell ran\n' > shell-result.txt
CHECK
chown -R nobody:nobody /workspace /state
stty -F /dev/hvc0 rows 34 cols 120
setsid sh -c 'exec </dev/hvc0 >/dev/hvc0 2>&1; exec su -s /bin/sh -c /opt/run-user nobody'
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
sleep 60
