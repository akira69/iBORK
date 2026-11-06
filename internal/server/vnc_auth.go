package server

import (
	"bytes"
	"errors"
	"io"
	"net"
)

var errVNCAuthenticationMethod = errors.New("generic VNC requires classic password authentication")

// Select classic authentication before exposing the stream to noVNC, which also supports None.
func negotiateVNCPassword(conn net.Conn) (hello, clientHello []byte, err error) {
	version := make([]byte, 12)
	if _, err = io.ReadFull(conn, version); err != nil {
		return nil, nil, err
	}
	legacy := string(version) == "RFB 003.003\n"
	if !legacy && string(version) != "RFB 003.007\n" && string(version) != "RFB 003.008\n" {
		return nil, nil, errVNCAuthenticationMethod
	}
	if _, err = conn.Write(version); err != nil {
		return nil, nil, err
	}
	if legacy {
		security := make([]byte, 4)
		if _, err = io.ReadFull(conn, security); err != nil {
			return nil, nil, err
		}
		if !bytes.Equal(security, []byte{0, 0, 0, 2}) {
			return nil, nil, errVNCAuthenticationMethod
		}
		return append(append([]byte{}, version...), security...), version, nil
	}
	count := make([]byte, 1)
	if _, err = io.ReadFull(conn, count); err != nil {
		return nil, nil, err
	}
	methods := make([]byte, int(count[0]))
	if _, err = io.ReadFull(conn, methods); err != nil {
		return nil, nil, err
	}
	if !bytes.Contains(methods, []byte{2}) {
		return nil, nil, errVNCAuthenticationMethod
	}
	if _, err = conn.Write([]byte{2}); err != nil {
		return nil, nil, err
	}
	return append(append([]byte{}, version...), 1, 2), append(version, 2), nil
}
