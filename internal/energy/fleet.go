package energy

import (
	"sort"
	"time"
)

// FleetBuckets integrates only intervals observed by every configured meter.
// Each interval is linear between consecutive readings, as on the web dashboard.
func FleetBuckets(series [][]Sample, now int64, count int, width int64) (averages []*float64, kwh *float64, hours float64) {
	averages = make([]*float64, count)
	if len(series) == 0 {
		return
	}
	start := now - int64(count)*width
	cursors := make([]int, len(series))
	for i, points := range series {
		cursors[i] = max(1, sort.Search(len(points), func(j int) bool { return points[j].At > start }))
	}
	covered := make([]int64, count)
	wattSeconds := make([]float64, count)
	for {
		left, right := start, now
		complete, valid := true, true
		for i, points := range series {
			j := cursors[i]
			if j >= len(points) || points[j].At > now {
				complete = false
				break
			}
			a, b := points[j-1], points[j]
			left, right = max(left, a.At), min(right, b.At)
			valid = valid && b.At-a.At <= int64(MaxSampleAge/time.Second)
		}
		if !complete {
			break
		}
		if valid && left < right {
			var watts, slope float64
			for i, points := range series {
				j := cursors[i]
				a, b := points[j-1], points[j]
				rate := (b.Watts - a.Watts) / float64(b.At-a.At)
				watts += a.Watts + rate*float64(left-a.At)
				slope += rate
			}
			for left < right {
				bin := (left - start) / width
				end := min(right, start+(bin+1)*width)
				seconds := end - left
				next := watts + slope*float64(seconds)
				wattSeconds[bin] += (watts + next) * 0.5 * float64(seconds)
				covered[bin] += seconds
				left, watts = end, next
			}
		}
		for i, points := range series {
			if points[cursors[i]].At == right {
				cursors[i]++
			}
		}
	}
	var total float64
	for i, seconds := range covered {
		if seconds > 0 {
			avg := wattSeconds[i] / float64(seconds)
			averages[i] = &avg
			hours += float64(seconds) / 3600
			total += wattSeconds[i] / 3600000
			kwh = &total
		}
	}
	return
}
