package energy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHistorySurvivesRestartAndTruncatedTail(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Minute)
	dir := t.TempDir()
	h, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	h.record(Sample{At: now.Unix(), Watts: 79}, nil, now)
	path := filepath.Join(dir, now.Format("2006-01-02")+".jsonl")
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString(`{"at":`)
	_ = f.Close()
	restored, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	restored.record(Sample{At: now.Add(time.Minute).Unix(), Watts: 80}, nil, now.Add(time.Minute))
	again, err := Open(dir, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	got := again.Snapshot(now.Add(time.Minute))
	if len(got.Samples) != 2 || got.Samples[0].Watts != 79 {
		t.Fatal(got)
	}
}
func TestFailedReadIsNotZeroAndPersistenceFailureVisible(t *testing.T) {
	now := time.Now()
	h, _ := Open(t.TempDir(), now)
	h.record(Sample{At: now.Unix(), Watts: 0}, errors.New("secret upstream text"), now)
	got := h.Snapshot(now)
	if len(got.Samples) != 0 || got.Error == "" || got.Error == "secret upstream text" {
		t.Fatal(got)
	}
	h.dir = filepath.Join(h.dir, "missing")
	h.record(Sample{At: now.Add(time.Minute).Unix(), Watts: 0}, nil, now.Add(time.Minute))
	got = h.Snapshot(now.Add(time.Minute))
	if len(got.Samples) != 1 || got.Samples[0].Watts != 0 || got.StorageError == "" {
		t.Fatal(got)
	}
}
func TestRetentionAndCorruption(t *testing.T) {
	now := time.Now().UTC()
	dir := t.TempDir()
	old := filepath.Join(dir, now.AddDate(0, 0, -32).Format("2006-01-02")+".jsonl")
	_ = os.WriteFile(old, []byte("old data"), 0600)
	keep := filepath.Join(dir, "do-not-delete.txt")
	_ = os.WriteFile(keep, []byte("keep"), 0600)
	h, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	h.record(Sample{At: now.Unix(), Watts: 100}, nil, now)
	if _, err = os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old retention file not removed")
	}
	if _, err = os.Stat(keep); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, now.Format("2006-01-02")+".jsonl"), []byte("not json\n"), 0600)
	if _, err = Open(dir, now); err == nil {
		t.Fatal("corrupt complete record accepted")
	}
}

func TestExpiredDamagedLogDoesNotDisableCurrentHistory(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	expired := now.AddDate(0, 0, -31).Format("2006-01-02") + ".jsonl"
	if err := os.WriteFile(filepath.Join(dir, expired), []byte("damaged\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, now); err != nil {
		t.Fatal(err)
	}
}

func TestMemoryOnlyFallbackPreservesReadingsWithoutWriting(t *testing.T) {
	h := MemoryOnly()
	now := time.Now()
	h.record(Sample{At: now.Unix(), Watts: 79}, nil, now)
	got := h.Snapshot(now)
	if len(got.Samples) != 1 || got.StorageError == "" || h.dir != "" {
		t.Fatal(got)
	}
}

func TestMeterObservationRetainsAgeAcrossCollectionTicks(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	h := MemoryOnly()
	h.SetSource("MQTT outlet power")
	point := Sample{At: now.Unix(), Watts: 0}
	h.record(point, nil, now)
	h.record(point, nil, now.Add(time.Minute))
	got := h.Snapshot(now.Add(time.Minute))
	if len(got.Samples) != 1 || got.Samples[0] != point || got.Error != "" || got.Source != "MQTT outlet power" {
		t.Fatal(got)
	}
	h.record(point, nil, now.Add(MaxSampleAge+time.Second))
	if got = h.Snapshot(now.Add(MaxSampleAge + time.Second)); len(got.Samples) != 1 || got.Error == "" {
		t.Fatal(got)
	}
}

func TestMissingWattsOnDiskAreNeverMeasuredZero(t *testing.T) {
	now := time.Unix(1735689600, 0).UTC()
	dir := t.TempDir()
	path := filepath.Join(dir, now.Format("2006-01-02")+".jsonl")
	for _, line := range []string{`{"at":1735689600}`, `{"at":1735689600,"watts":null}`} {
		if err := os.WriteFile(path, []byte(line+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(dir, now); err == nil {
			t.Fatal("restored absent watts as zero")
		}
	}
}

func TestCancelledCollectorDoesNotStartOrSaveARead(t *testing.T) {
	for _, alreadyCancelled := range []bool{true, false} {
		h := MemoryOnly()
		ctx, cancel := context.WithCancel(t.Context())
		if alreadyCancelled {
			cancel()
		}
		called := false
		h.Run(ctx, func(context.Context) (Sample, error) {
			called = true
			cancel()
			return Sample{At: time.Now().Unix(), Watts: 42}, nil
		})
		cancel()
		if called == alreadyCancelled || len(h.Snapshot(time.Now()).Samples) != 0 {
			t.Fatal("collection survived cancellation", alreadyCancelled)
		}
	}
}
