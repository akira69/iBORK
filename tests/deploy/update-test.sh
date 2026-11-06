#!/usr/bin/env bash
set -euo pipefail
deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../deploy" && pwd)
# shellcheck source=../../deploy/jet-supermicro-update
source "$deploy_dir/jet-supermicro-update"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
APP_DIR="$test_root/app"
LOCK_FILE="$test_root/lock"
CONFIG_FILE="$test_root/config.env"
printf 'APP_ORIGIN=https://test.example\n' > "$CONFIG_FILE"
mkdir -p "$APP_DIR/releases/v0.1.0" "$test_root/assets" "$test_root/bin"
for name in "${ASSETS[@]}"; do printf old > "$APP_DIR/releases/v0.1.0/$name"; done
(cd "$APP_DIR/releases/v0.1.0"; sha256sum "${ASSETS[@]}" > SHA256SUMS)
ln -s releases/v0.1.0 "$APP_DIR/current"
for name in "${ASSETS[@]}"; do printf new > "$test_root/assets/$name"; done
(cd "$test_root/assets"; sha256sum "${ASSETS[@]}" > SHA256SUMS)
export TEST_ASSETS="$test_root/assets" TEST_APP="$APP_DIR"
cat > "$test_root/bin/systemctl" <<'MOCK'
#!/bin/bash
exit 0
MOCK
cat > "$test_root/bin/curl" <<'MOCK'
#!/bin/bash
case ${*: -1} in
  'https://api.github.com/repos/akira69/iBORK/releases?per_page=1')
    printf '[{"tag_name":"v0.2.0","draft":%s}]\n' "${TEST_DRAFT:-false}"
    exit ;;
  https://github.com/akira69/iBORK/releases/download/v0.2.0/*)
    [[ ${TEST_DOWNLOAD_FAIL:-0} == 0 ]] || exit 28
    asset=${*: -1}
    while [[ $# -gt 0 ]]; do
      if [[ $1 == --output ]]; then cp "$TEST_ASSETS/${asset##*/}" "$2"; exit; fi
      shift
    done
    exit 1 ;;
esac
if [[ $* != *'Host: test.example'* ]]; then echo 403; exit; fi
if [[ ${TEST_UNHEALTHY:-0} == 1 && $(readlink "$TEST_APP/current") == releases/v0.2.0 ]]; then echo 500; else echo 401; fi
MOCK
printf '#!/bin/sh\nexit 0\n' > "$test_root/bin/sleep"
chmod +x "$test_root/bin/"*
export PATH="$test_root/bin:$PATH"
expect_old() { [[ $(readlink "$APP_DIR/current") == releases/v0.1.0 ]]; }
expect_failure() {
  set +e
  (main "$@") >"$test_root/failure.log" 2>&1
  result=$?
  set -e
  if [[ $result == 0 ]]; then echo "Unexpected success: $*"; exit 1; fi
  expect_old
}
(main --check)
expect_old
TEST_DRAFT=true expect_failure --check
expect_failure '../bad-tag'
TEST_DOWNLOAD_FAIL=1 expect_failure v0.2.0
printf corrupt >> "$test_root/assets/jet-supermicro-linux-amd64"
expect_failure v0.2.0
(cd "$test_root/assets"; sha256sum "${ASSETS[@]}" > SHA256SUMS)
printf '%064d  ../../outside\n' 0 >> "$test_root/assets/SHA256SUMS"
expect_failure v0.2.0
(cd "$test_root/assets"; sha256sum "${ASSETS[@]}" > SHA256SUMS)
(exec 8>"$LOCK_FILE"; flock -n 8; expect_failure v0.2.0)
TEST_UNHEALTHY=1 expect_failure v0.2.0
ln -s releases/v0.1.0 "$APP_DIR/.current-next"
(main v0.2.0)
[[ $(readlink "$APP_DIR/current") == releases/v0.2.0 ]]
(main --rollback)
expect_old
# Rewrite fixed deployment paths into the fixture; no host paths are modified.
fixture="$test_root/install"
mkdir -p "$fixture/usr/local/bin" "$fixture/usr/local/sbin" "$fixture/etc/profile.d" "$fixture/etc/systemd/system" "$fixture/etc/jet-supermicro" "$fixture/run/lock"
for name in config.env app-password-hash.cred; do touch "$fixture/etc/jet-supermicro/$name"; done
cp "$CONFIG_FILE" "$fixture/etc/jet-supermicro/config.env"
for script in install-release.sh jet-supermicro-update; do
  sed -e "s|/opt/jet-supermicro|$fixture/opt/jet-supermicro|g" -e "s|/run/lock/jet-supermicro|$fixture/run/lock/jet-supermicro|g" -e "s|/usr/local/|$fixture/usr/local/|g" -e "s|/etc/|$fixture/etc/|g" "$deploy_dir/$script" > "$fixture/$script"
done
cat > "$test_root/bin/ln" <<'MOCK'
#!/bin/bash
if [[ ${TEST_INSTALL_FAIL:-0} == 1 && ${*: -1} == */usr/local/bin/update ]]; then exit 1; fi
exec /usr/bin/ln "$@"
MOCK
chmod +x "$test_root/bin/ln"
set +e
TEST_INSTALL_FAIL=1 bash "$fixture/install-release.sh" v0.2.0 >"$test_root/install-failure.log" 2>&1
result=$?
set -e
[[ $result != 0 && ! -L $fixture/opt/jet-supermicro/current ]]
bash "$fixture/install-release.sh" v0.2.0
[[ -L $fixture/usr/local/bin/update && -L $fixture/etc/systemd/system/jet-supermicro.service ]]
echo 'Updater tests passed: invalid input, timeout, corruption, path injection, locking, rollback and success.'
