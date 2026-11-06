package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/akira69/iBORK/internal/server"
	"golang.org/x/crypto/bcrypt"
)

func appPasswordHash(dir string) (string, error) {
	data, err := os.ReadFile(filepath.Join(dir, "app-password-hash"))
	if errors.Is(err, os.ErrNotExist) {
		return secret("APP_PASSWORD_HASH_FILE")
	}
	if err != nil {
		return "", errors.New("cannot read saved app password hash")
	}
	return strings.TrimRight(string(data), "\r\n"), nil
}

func saveAppPasswordHash(dir, hash string) error {
	if _, err := bcrypt.Cost([]byte(hash)); err != nil {
		return errors.New("invalid password hash")
	}
	return replaceProtected(dir, "app-password-hash", []byte(hash))
}

const panelPINFile = "panel-pin-override"

// The bootstrap fingerprint lets an administrator reset the PIN by rotating its credential.
func panelPINHash(dir, bootstrap string) (string, error) {
	if bootstrap == "" {
		return "", nil
	}
	f, err := os.Open(filepath.Join(dir, panelPINFile))
	if errors.Is(err, os.ErrNotExist) {
		return bootstrap, nil
	}
	if err != nil {
		return "", errors.New("cannot open the saved panel PIN")
	}
	defer f.Close()
	const recordSize = 64 + 1 + 60 // SHA-256 hex, newline, bcrypt hash
	data, err := io.ReadAll(io.LimitReader(f, recordSize+1))
	id, hash, ok := strings.Cut(string(data), "\n")
	if err != nil || len(data) != recordSize || !ok || len(id) != 64 {
		return "", errors.New("invalid saved panel PIN record")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return "", errors.New("invalid panel bootstrap fingerprint")
	}
	if id != fmt.Sprintf("%x", sha256.Sum256([]byte(bootstrap))) {
		return bootstrap, nil
	}
	return hash, nil // EnablePanel validates the effective bcrypt hash.
}

func savePanelPINHash(dir, bootstrap, hash string) error {
	if _, err := server.PanelPINCost(hash); bootstrap == "" || err != nil {
		return errors.New("invalid replacement panel PIN hash")
	}
	record := fmt.Sprintf("%x\n%s", sha256.Sum256([]byte(bootstrap)), hash)
	return replaceProtected(dir, panelPINFile, []byte(record))
}

func replaceProtected(dir, name string, data []byte) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	temp, err := writeProtected(dir, data)
	if err != nil {
		return err
	}
	defer os.Remove(temp)
	return os.Rename(temp, filepath.Join(dir, name))
}
