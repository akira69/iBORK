package telemetryhttp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

func ValidBearer(token string) bool {
	if len(token) == 0 || len(token) > 4096 {
		return false
	}
	for i := range len(token) {
		if token[i] <= ' ' || token[i] > '~' {
			return false
		}
	}
	return true
}

func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func GetJSON(ctx context.Context, client *http.Client, endpoint, token string, dest any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("telemetry endpoint returned HTTP %d", resp.StatusCode)
	}
	const maxSize = 256 * 1024
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSize+1))
	if err != nil {
		return err
	}
	if len(data) > maxSize {
		return errors.New("telemetry response too large")
	}
	return json.Unmarshal(data, dest)
}
