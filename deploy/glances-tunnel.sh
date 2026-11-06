#!/usr/bin/env bash
# Run on the iBORK Debian/systemd host in a root terminal. The UI embeds this file.
set -euo pipefail
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || die 'Run in a root shell on the iBORK host.'
host=${1:-}
port=${2:-}
[[ $host =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die 'Enter an IPv4 address.'
IFS=. read -r -a octets <<< "$host"
for n in "${octets[@]}"; do
  if [[ $n != 0 && $n == 0* ]] || (( 10#$n > 255 )); then die 'Invalid IPv4 address.'; fi
done
if [[ ! $port =~ ^[1-9][0-9]{3,4}$ ]] || (( port < 1024 || port > 65535 )); then die 'Choose a local port from 1024 to 65535.'; fi
for cmd in ssh ssh-keygen systemctl ss ip curl python3 flock; do
  command -v "$cmd" >/dev/null || die "Missing command: $cmd"
done
name=ibork-glances-${host//./-}
dir=/etc/$name
unit=/etc/systemd/system/$name.service
origin=http://127.0.0.1:$port
listeners=$(ss -ltnH "sport = :$port")
[[ -z $listeners ]] || die "Port $port is in use. Use the existing tunnel or choose another port."
source_ip=$(ip -4 route get "$host" | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')
[[ $source_ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die 'Cannot determine the iBORK source address.'
umask 077
install -d -m 0700 "$dir"
exec 9>"$dir/setup.lock"
flock -n 9 || die 'Setup for this server is already running.'
[[ ! -e $unit ]] || die "$unit already exists. Check systemctl status $name before changing it."
[[ -f $dir/identity ]] || ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$dir/identity"
pub=$(ssh-keygen -y -f "$dir/identity" | cut -d' ' -f1,2)
cat <<REMOTE

On the Glances server, run this block as root:

(
set -eu
id ibork-glances >/dev/null 2>&1 || adduser --system --group --home /var/lib/ibork-glances --shell /usr/sbin/nologin ibork-glances
test "\$(getent passwd ibork-glances | cut -d: -f6)" = /var/lib/ibork-glances
key='from="$source_ip",restrict,port-forwarding,permitopen="127.0.0.1:61208",permitlisten="127.0.0.1:1",command="/usr/sbin/nologin" $pub'
runuser -u ibork-glances -- sh -eu -c '
  umask 077
  cd /var/lib/ibork-glances
  mkdir -p .ssh
  touch .ssh/authorized_keys
  chmod 700 .ssh
  chmod 600 .ssh/authorized_keys
  grep -qxF "\$1" .ssh/authorized_keys || echo "\$1" >> .ssh/authorized_keys
' sh "\$key"
cat /etc/ssh/ssh_host_ed25519_key.pub
)

REMOTE
printf 'Paste the ssh-ed25519 HOST PUBLIC key printed by that server, then press Enter: '
read -r kind blob _ </dev/tty
[[ $kind == ssh-ed25519 && $blob =~ ^[A-Za-z0-9+/]{68}$ ]] || die 'Expected one OpenSSH Ed25519 public host key.'
ssh-keygen -lf /dev/stdin <<< "$kind $blob" >/dev/null || die 'Invalid Ed25519 host key.'
pin="$host $kind $blob"
new_pin=false
if [[ -e $dir/known_hosts ]]; then
  grep -qxF "$pin" "$dir/known_hosts" || die 'Saved host key differs. Verify the host identity before retrying.'
else
  printf '%s\n' "$pin" > "$dir/known_hosts"
  new_pin=true
fi
rollback() {
  systemctl disable --now "$name" >/dev/null 2>&1 || systemctl stop "$name" || :
  rm -f -- "$unit"
  if [[ $new_pin == true ]]; then rm -f -- "$dir/known_hosts"; fi
  systemctl daemon-reload
}
trap rollback EXIT
cat > "$unit" <<UNIT
[Unit]
Description=iBORK Glances tunnel to $host
After=network-online.target
Wants=network-online.target

[Service]
DynamicUser=yes
LoadCredential=identity:$dir/identity
LoadCredential=known_hosts:$dir/known_hosts
ExecStart=/usr/bin/ssh -F /dev/null -NT -i %d/identity -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%d/known_hosts -o GlobalKnownHostsFile=/dev/null -o ExitOnForwardFailure=yes -o ConnectTimeout=8 -o ServerAliveInterval=30 -o ServerAliveCountMax=2 -L 127.0.0.1:$port:127.0.0.1:61208 ibork-glances@$host
Restart=on-failure
RestartSec=60
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 "$unit"
systemctl daemon-reload
verified=false
if systemctl start "$name"; then
  for ((attempt=0;attempt<5;attempt++)); do
    pid=$(systemctl show -p MainPID --value "$name")
    if [[ $pid != 0 ]] &&
      ss -ltnpH "sport = :$port" | grep -F "pid=$pid," >/dev/null &&
      curl -fsS --noproxy '*' --connect-timeout 2 --max-time 4 "$origin/api/4/sensors" |
        python3 -c '
import json, sys
limit = 256 * 1024
data = sys.stdin.buffer.read(limit + 1)
sys.exit(0 if len(data) <= limit and isinstance(json.loads(data), list) else 1)
' 2>/dev/null; then
      verified=true
      break
    fi
    sleep 1
  done
fi
if [[ $verified == false ]]; then
  die "Glances did not respond. Check journalctl -u $name and the Glances listener, then rerun setup. Your tunnel key was kept."
fi
systemctl enable "$name"
trap - EXIT
printf '\nVerified Glances API origin: %s\n' "$origin"
