package management

import (
	"github.com/bougou/go-ipmi/pkg/command/dcmi"
	"testing"
)

func TestPowerMeasurementValidity(t *testing.T) {
	for _, test := range []struct {
		reading *dcmi.GetDCMIPowerReadingResponse
		want    float64
		valid   bool
	}{
		{nil, 0, false}, {&dcmi.GetDCMIPowerReadingResponse{CurrentPower: 79}, 0, false},
		{&dcmi.GetDCMIPowerReadingResponse{CurrentPower: 79, PowerMeasurementActive: true}, 79, true},
		{&dcmi.GetDCMIPowerReadingResponse{PowerMeasurementActive: true}, 0, true},
	} {
		got, err := measurementWatts(test.reading)
		if (err == nil) != test.valid || got != test.want {
			t.Fatalf("got %v %v", got, err)
		}
	}
}
