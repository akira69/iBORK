package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func configureStoredSetting(dir, name string, limit int64, configure func([]byte, func([]byte) error) error) error {
	var data []byte
	f, err := os.Open(filepath.Join(dir, name))
	if err == nil {
		defer f.Close()
		data, err = io.ReadAll(io.LimitReader(f, limit+1))
		if err != nil {
			return err
		}
		if int64(len(data)) > limit {
			return fmt.Errorf("saved %s exceeds size limit", name)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return configure(data, func(data []byte) error { return replaceProtected(dir, name, data) })
}
