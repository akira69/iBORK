# shellcheck shell=sh
# Display local status at interactive shell login; never fetch or execute remote code.
case $- in
  *i*)
    jsm_version=$(readlink /opt/jet-supermicro/current 2>/dev/null)
    jsm_url=$(cat /opt/jet-supermicro/url 2>/dev/null)
    jsm_status=$(systemctl is-active jet-supermicro 2>/dev/null)
    printf '\n\033[1;36miBORK\033[0m  |  Finch13\n'
    printf '  Web:     %s\n  Version: %s\n  Service: %s\n' "$jsm_url" "${jsm_version#releases/}" "$jsm_status"
    printf '  Update:  update --check | update | update --rollback\n'
    printf '  Logs:    journalctl -u jet-supermicro -n 50\n\n'
    unset jsm_version jsm_url jsm_status
    ;;
esac
