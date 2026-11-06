#!/usr/bin/env bash
# Run from a trusted checkout after configuring credentials and config.env.
set -euo pipefail
# shellcheck source=jet-supermicro-update
source "$(dirname "$0")/jet-supermicro-update"
[[ $EUID == 0 && $# == 1 ]] || { echo 'Usage (root): install-release.sh vX.Y.Z'; exit 1; }
valid_tag "$1" || { echo 'Invalid release tag.' >&2; exit 1; }
install -d -m 0755 "$APP_DIR/releases"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 1
[[ ! -e $APP_DIR/current && ! -L $APP_DIR/current ]] || { echo 'Already installed; use update.' >&2; exit 1; }
for path in /usr/local/bin/update /usr/local/sbin/jet-supermicro-update /etc/profile.d/jet-supermicro.sh /etc/systemd/system/jet-supermicro.service "$APP_DIR/jet-supermicro"; do
  [[ ! -e $path && ! -L $path ]] || { echo "Refusing to overwrite $path" >&2; exit 1; }
done
for name in config.env app-password-hash.cred; do
  [[ -f /etc/jet-supermicro/$name ]] || { echo "Missing /etc/jet-supermicro/$name" >&2; exit 1; }
done
stage=$(mktemp -d "$APP_DIR/.install.XXXXXX")
created=()
installed=0
# shellcheck disable=SC2317
cleanup_install() {
  result=$?
  trap - EXIT
  if [[ $installed == 0 && ${#created[@]} -gt 0 ]]; then rm -f -- "${created[@]}"; fi
  rm -rf -- "$stage"
  exit "$result"
}
trap cleanup_install EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
download_release "$1" "$stage"
verify_release "$stage" || { echo 'Release checksum verification failed.' >&2; exit 1; }
chmod 0755 "$stage" "$stage/jet-supermicro-linux-amd64" "$stage/jet-supermicro-update"
chmod 0644 "$stage/jet-supermicro-login.sh" "$stage/jet-supermicro.service" "$stage/SHA256SUMS"
if [[ -e $APP_DIR/releases/$1 ]]; then
  if ! verify_release "$APP_DIR/releases/$1" || ! cmp -s "$stage/SHA256SUMS" "$APP_DIR/releases/$1/SHA256SUMS"; then echo 'Existing release differs.' >&2; exit 1; fi
else mv "$stage" "$APP_DIR/releases/$1"; fi
install_link() {
  created+=("$2")
  ln -sT "$1" "$2"
}
install_link "releases/$1" "$APP_DIR/current"
install_link current/jet-supermicro-linux-amd64 "$APP_DIR/jet-supermicro"
install_link "$APP_DIR/current/jet-supermicro-update" /usr/local/sbin/jet-supermicro-update
install_link "$APP_DIR/current/jet-supermicro-update" /usr/local/bin/update
install_link "$APP_DIR/current/jet-supermicro-login.sh" /etc/profile.d/jet-supermicro.sh
install_link "$APP_DIR/current/jet-supermicro.service" /etc/systemd/system/jet-supermicro.service
systemctl daemon-reload
installed=1
systemctl enable --now jet-supermicro
healthy || { echo 'Startup failed; inspect journalctl -u jet-supermicro.' >&2; exit 1; }
echo "Installed $1."
