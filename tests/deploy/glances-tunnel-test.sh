#!/usr/bin/env bash
# Run as root on a Linux test host with unshare, overlayfs and util-linux script.
set -euo pipefail
setup=$(realpath "$(dirname "$0")/../../deploy/glances-tunnel.sh")
unshare --mount --propagation private bash -seu -o pipefail -s -- "$setup" "${1:-}" <<'TEST'
setup=$1
cli=$2
tmp=$(mktemp -d)
trap 'umount /etc 2>/dev/null || :; rm -rf -- "$tmp"' EXIT
mkdir "$tmp"/{etc,work,bin}
mount -t overlay overlay -o "lowerdir=/etc,upperdir=$tmp/etc,workdir=$tmp/work" /etc
export PATH="$tmp/bin:$PATH" TEST_DIR="$tmp"
cat > "$tmp/bin/systemctl" <<'MOCK'
#!/bin/sh
echo "$1" >> "$TEST_DIR/calls"
if [ "$1" = disable ]; then test "$2" = --now; exit; fi
if [ "$1" = enable ] && [ -e "$TEST_DIR/fail-enable" ]; then exit 1; fi
if [ "$1" = show ]; then echo 777; fi
MOCK
cat > "$tmp/bin/ss" <<'MOCK'
#!/bin/sh
if [ "$1" = -ltnpH ]; then echo 'users:(("ssh",pid=777,fd=3))'; fi
MOCK
cat > "$tmp/bin/curl" <<'MOCK'
#!/bin/sh
if [ -e "$TEST_DIR/timeout" ]; then exit 28; fi
if [ -e "$TEST_DIR/oversize" ]; then python3 -c 'print("["+" "*300000+"]")'; exit; fi
echo '[]'
MOCK
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/sleep"
chmod +x "$tmp/bin/"*
ssh-keygen -q -t ed25519 -N '' -f "$tmp/host"
name=ibork-glances-127-0-0-2
unit=/etc/systemd/system/$name.service
test ! -e "$unit" && test ! -e "/etc/$name" || exit 1
run() { script -qec "bash '$setup' 127.0.0.2 62001" /dev/null < "$tmp/host.pub" > "$tmp/output"; }
touch "$tmp/timeout"
if [[ -n $cli ]]; then
  if script -qec "'$cli' glances-tunnel 127.0.0.2 62001" /dev/null < "$tmp/host.pub" > "$tmp/output"; then
    echo 'Packaged CLI ignored a sensor timeout'; exit 1
  fi
  tr -d '\r' < "$tmp/output" | grep -Ex '127\.0\.0\.1 ssh-ed25519 [A-Za-z0-9+/]{68}' >/dev/null
elif run; then echo 'Timeout unexpectedly succeeded'; exit 1; fi
test ! -e "$unit"
test ! -e "/etc/$name/known_hosts"
grep -qx disable "$tmp/calls"
if grep -qx enable "$tmp/calls"; then exit 1; fi
key=$(ssh-keygen -lf "/etc/$name/identity.pub")
rm "$tmp/timeout"
for failure in oversize fail-enable; do
  touch "$tmp/$failure"
  if run; then echo "Unexpected success with $failure"; exit 1; fi
  test ! -e "$unit"
  test ! -e "/etc/$name/known_hosts"
  rm "$tmp/$failure"
done
run
test "$key" = "$(ssh-keygen -lf "/etc/$name/identity.pub")"
grep -q 'StrictHostKeyChecking=yes' "$unit"
grep -q 'Verified Glances API origin: http://127.0.0.1:62001' "$tmp/output"
grep -qx enable "$tmp/calls"
sed -n '/^(\r*$/,/^)\r*$/p' "$tmp/output" | tr -d '\r' > "$tmp/authorize.sh"
grep -Fq 'permitopen="127.0.0.1:61208"' "$tmp/authorize.sh"
bash -n "$tmp/authorize.sh"
if run; then echo 'Duplicate tunnel unexpectedly succeeded'; exit 1; fi
echo 'Tunnel setup, failure cleanup, retry and existing-unit protection passed.'
TEST
