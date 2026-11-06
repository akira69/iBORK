package energy

import (
	"math"
	"testing"
	"time"
)

func TestFleetBucketsOverlapAcrossBinsAndGaps(t *testing.T) {
	series := [][]Sample{
		{{900, 20}, {1000, 120}, {1400, 50}, {1450, 50}},
		{{950, 10}, {1050, 10}, {1390, 0}, {1440, 0}},
	}
	// Bin boundary at 975 splits the ramp: 80..105 W, then 105..130 W.
	bins, kwh, hours := FleetBuckets(series, 1475, 6, 100)
	if bins[0] == nil || *bins[0] != 92.5 || bins[1] == nil || *bins[1] != 117.5 ||
		bins[2] != nil || bins[3] != nil || bins[4] != nil || bins[5] == nil || *bins[5] != 50 ||
		kwh == nil || math.Abs(*kwh-(105.0*50+50*40)/3600000) > 1e-12 || math.Abs(hours-90.0/3600) > 1e-12 {
		t.Fatal(bins, kwh, hours)
	}
	for _, partial := range [][][]Sample{nil, {series[0], nil}, {series[0], {{2100, 2}, {2150, 2}}}} {
		bins, kwh, hours := FleetBuckets(partial, 1475, 1, 600)
		if bins[0] != nil || hours != 0 || kwh != nil {
			t.Fatal(bins, kwh, hours)
		}
	}
	bins, kwh, _ = FleetBuckets([][]Sample{{{1400, 0}, {1450, 0}}}, 1475, 1, 100)
	if bins[0] == nil || *bins[0] != 0 || kwh == nil || *kwh != 0 {
		t.Fatal("lost observed zero")
	}
}

func TestMonthHistorySurvivesRestartWithoutExpandingWebSnapshot(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Minute)
	dir := t.TempDir()
	h, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range []time.Time{now.Add(-30*24*time.Hour - time.Minute), now.Add(-30 * 24 * time.Hour), now} {
		h.record(Sample{At: at.Unix(), Watts: 80}, nil, at)
	}
	h, err = Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.MonthSnapshot(now).Samples) != 3 || len(h.Snapshot(now).Samples) != 1 {
		t.Fatal("unexpected history window")
	}
}
