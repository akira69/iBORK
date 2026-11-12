package energy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const MaxSampleAge = 150 * time.Second
const retentionDays = 30
const retention = retentionDays*24*time.Hour + MaxSampleAge
const MQTTSource = "MQTT outlet power"
const MatterSource = "Matter via Home Assistant"

type Sample struct {
	At    int64   `json:"at"`
	Watts float64 `json:"watts"`
}
type Snapshot struct {
	Samples      []Sample `json:"samples"`
	Now          int64    `json:"now"`
	Error        string   `json:"error,omitempty"`
	StorageError string   `json:"storageError,omitempty"`
	Source       string   `json:"source"`
}
type History struct {
	mu                      sync.Mutex
	source                  string
	dir                     string
	samples                 []Sample
	readError, storageError string
}
type Reader func(context.Context) (Sample, error)

// SetSource is called during setup, before the collector starts.
func (h *History) SetSource(source string) { h.source = source }

func MemoryOnly() *History {
	return &History{samples: []Sample{}, storageError: "Power history storage is unavailable. Collection is memory-only; repair storage and restart to restore persistence."}
}

func Open(dir string, now time.Time) (*History, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, errors.New("cannot create power history directory")
	}
	h := &History{dir: dir, samples: []Sample{}}
	for day := now.UTC().Add(-retention).Truncate(24 * time.Hour); !day.After(now); day = day.AddDate(0, 0, 1) {
		name := day.Format("2006-01-02") + ".jsonl"
		data, err := readLog(filepath.Join(dir, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, errors.New("cannot read power history file")
		}
		// Ignore only an interrupted final write; complete malformed records fail closed.
		end := bytes.LastIndexByte(data, '\n')
		if end < 0 {
			continue
		}
		for _, line := range bytes.Split(data[:end], []byte{'\n'}) {
			// Missing or null watts must never restore as a measured zero.
			point := Sample{Watts: math.NaN()}
			if json.Unmarshal(line, &point) != nil || !valid(point) || (len(h.samples) > 0 && point.At <= h.samples[len(h.samples)-1].At) {
				return nil, errors.New("invalid power history record")
			}
			h.samples = append(h.samples, point)
		}
	}
	h.trim(now)
	return h, nil
}
func valid(p Sample) bool {
	return p.At > 0 && !math.IsNaN(p.Watts) && !math.IsInf(p.Watts, 0) && p.Watts >= 0 && p.Watts <= 65535
}

func readLog(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 2*1024*1024+1))
	if len(data) > 2*1024*1024 {
		return nil, errors.New("power history file exceeds size limit")
	}
	return data, err
}
func (h *History) trim(now time.Time) {
	cutoff := now.Add(-retention).Unix()
	i := 0
	for i < len(h.samples) && h.samples[i].At < cutoff {
		i++
	}
	h.samples = h.samples[i:]
}
func (h *History) Snapshot(now time.Time) Snapshot {
	return h.snapshot(now, 7*24*time.Hour+MaxSampleAge)
}
func (h *History) MonthSnapshot(now time.Time) Snapshot {
	return h.snapshot(now, retention)
}
func (h *History) LatestWatts(now time.Time) *float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.readError != "" || len(h.samples) == 0 {
		return nil
	}
	last := h.samples[len(h.samples)-1]
	age := now.Unix() - last.At
	if age < 0 || age > int64(MaxSampleAge/time.Second) {
		return nil
	}
	return &last.Watts
}
func (h *History) snapshot(now time.Time, span time.Duration) Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.trim(now)
	source := h.source
	if source == "" {
		source = "DCMI system power · sampled every 30 seconds"
	}
	cutoff := now.Add(-span).Unix()
	first := sort.Search(len(h.samples), func(i int) bool { return h.samples[i].At >= cutoff })
	return Snapshot{Samples: append([]Sample{}, h.samples[first:]...), Now: now.Unix(), Error: h.readError, StorageError: h.storageError, Source: source}
}
func (h *History) Run(ctx context.Context, read Reader) {
	timer := time.NewTicker(30 * time.Second)
	defer timer.Stop()
	for ctx.Err() == nil {
		point, err := read(ctx)
		if ctx.Err() != nil {
			return
		}
		h.record(point, err, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}
func (h *History) record(point Sample, err error, now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.trim(now)
	if err != nil || !valid(point) || point.At > now.Unix() || now.Unix()-point.At > int64(MaxSampleAge/time.Second) {
		switch h.source {
		case MQTTSource:
			h.readError = "No fresh MQTT watts. Check the broker, status topic and reporting interval."
		case MatterSource:
			h.readError = "No fresh meter reading. Check the Home Assistant power sensor and its report time."
		default:
			h.readError = "Power telemetry unavailable. Check DCMI support, connection and credentials."
		}
		return
	}
	if len(h.samples) > 0 && point == h.samples[len(h.samples)-1] {
		h.readError = ""
		return
	}
	if len(h.samples) > 0 && point.At <= h.samples[len(h.samples)-1].At {
		h.readError = "Waiting for collection clock to advance."
		return
	}
	h.readError = ""
	h.samples = append(h.samples, point)
	if h.dir == "" {
		return
	}
	if h.persist(point) != nil {
		h.storageError = "Power history could not be saved. New readings are memory-only until storage recovers."
	} else {
		h.storageError = ""
	}
}
func (h *History) persist(point Sample) error {
	if h.dir == "" {
		return errors.New("history storage disabled")
	}
	now := time.Unix(point.At, 0).UTC()
	name := filepath.Join(h.dir, now.Format("2006-01-02")+".jsonl")
	// Repair an interrupted append without discarding any complete record.
	data, err := readLog(name)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		if err = os.Truncate(name, int64(bytes.LastIndexByte(data, '\n')+1)); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(f).Encode(point)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		date, e := time.Parse("2006-01-02.jsonl", entry.Name())
		if e == nil && !entry.IsDir() && date.Before(now.Add(-retention).Truncate(24*time.Hour)) {
			if e = os.Remove(filepath.Join(h.dir, entry.Name())); e != nil {
				return e
			}
		}
	}
	return nil
}
