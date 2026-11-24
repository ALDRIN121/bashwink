#!/bin/sh
# Bounded synthetic guest workload. Its only writable backing device is the fixture disk.
set -eu
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
insmod /virtio_blk.ko
for i in 1 2 3 4 5; do
    test -b /dev/vda && break
    sleep 1
done
previous=$(dd if=/dev/vda bs=512 count=1 2>/dev/null | tr -d '\000')
previous=${previous:-0}
echo "APPROVED previous=$previous"
if (echo bad > '@CANARY@') 2>/dev/null; then
    echo "unexpected guest write to host path"
    exit 1
fi
echo HOST_WRITE_DENIED
test "$(ls /sys/class/net)" = lo
if nc -w 1 127.0.0.1 '@PORT@' < /dev/null || nc -w 1 192.168.64.1 '@PORT@' < /dev/null; then
    echo "unexpected guest network route"
    exit 1
fi
echo NETWORK_DENIED
exec 3</dev/null
/bin/busybox setsid /bin/sh -c '
    set -eu
    exec 3<&-
    test ! -e /proc/$$/fd/3
    read -r pid name state parent group session rest < /proc/$$/stat
    test "$pid" = "$session"
    echo "DETACHED_OK pid=$pid group=$group session=$session fd3=closed"
    n=$1
    for i in $(seq 1 90); do
        n=$((n+1))
        printf "%s" "$n" | dd of=/dev/vda bs=512 conv=sync,fsync,notrunc 2>/dev/null
        sleep 0.3
    done
' worker "$previous" &
sleep 40
/bin/busybox poweroff -f
