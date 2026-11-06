# Create the tunnel account
id ibork-glances >/dev/null 2>&1 || adduser --system --group --home /var/lib/ibork-glances --shell /usr/sbin/nologin ibork-glances

# Authorize the tunnel key
test "$(getent passwd ibork-glances | cut -d: -f6)" = /var/lib/ibork-glances && runuser -u ibork-glances -- sh -eu -c 'umask 077; cd /var/lib/ibork-glances; mkdir -p .ssh; touch .ssh/authorized_keys; chmod 700 .ssh; chmod 600 .ssh/authorized_keys; grep -qxF "$1" .ssh/authorized_keys || printf "%s\n" "$1" >> .ssh/authorized_keys' sh 'from="SOURCE_IPV4",restrict,port-forwarding,permitopen="127.0.0.1:61208",permitlisten="127.0.0.1:1",command="/usr/sbin/nologin" SSH_PUBLIC_KEY'

# Read the server host key
cat /etc/ssh/ssh_host_ed25519_key.pub
