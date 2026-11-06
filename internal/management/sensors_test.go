package management

import (
	"context"
	"errors"
	"testing"

	"github.com/bougou/go-ipmi/pkg/command/sensor"
	"github.com/bougou/go-ipmi/pkg/types"
)

type sensorFixture struct {
	records []*types.SDR
	reading *sensor.GetSensorReadingResponse
	err     error
	calls   int
}

func (f *sensorFixture) GetSDRsRaw(context.Context, ...types.SDRRecordType) ([]*types.SDR, error) {
	return f.records, nil
}
func (f *sensorFixture) GetSensorReading(ctx context.Context, _ uint8) (*sensor.GetSensorReadingResponse, error) {
	f.calls++
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return f.reading, f.err
}
func (f *sensorFixture) GetSensorReadingFactors(context.Context, uint8, uint8) (*sensor.GetSensorReadingFactorsResponse, error) {
	return &sensor.GetSensorReadingFactorsResponse{ReadingFactors: types.ReadingFactors{M: 2}}, nil
}
func temperatureSDR(owner types.GeneratorID) *types.SDR {
	return &types.SDR{RecordHeader: &types.SDRHeader{RecordType: types.SDRRecordTypeFullSensor}, Full: &types.SDRFull{
		GeneratorID: owner, SensorNumber: 1, IDStringBytes: []byte("CPU Temp"), SensorType: types.SensorTypeTemperature,
		SensorEventReadingType: types.EventReadingTypeThreshold, SensorUnit: types.SensorUnit{BaseUnit: types.SensorUnitType_DegreesC}, ReadingFactors: types.ReadingFactors{M: 1},
	}}
}
func TestSoftwareSensorsDoNotBlockHardwareReadings(t *testing.T) {
	f := &sensorFixture{records: []*types.SDR{temperatureSDR(0xb1), temperatureSDR(0x20)}, reading: &sensor.GetSensorReadingResponse{Reading: 42, Above_UCR: true}}
	got, err := readSensors(context.Background(), f)
	if err != nil || len(got) != 2 || f.calls != 1 {
		t.Fatalf("%+v %v calls=%d", got, err, f.calls)
	}
	if got[0].State != "unavailable" || got[0].Value != "Unavailable" {
		t.Fatal(got[0])
	}
	if got[1].Value != "42" || got[1].State != "critical" || got[1].ID != "0020:01" {
		t.Fatal(got[1])
	}
}
func TestUnreadableSensorsNeverBecomeHealthyZero(t *testing.T) {
	for _, r := range []*sensor.GetSensorReadingResponse{{ReadingUnavailable: true}, {SensorScanningDisabled: true}} {
		f := &sensorFixture{records: []*types.SDR{temperatureSDR(0x20)}, reading: r}
		got, err := readSensors(context.Background(), f)
		if err != nil || got[0].State != "unavailable" || got[0].Value != "Unavailable" {
			t.Fatalf("%+v %v", got, err)
		}
	}
	f := &sensorFixture{records: []*types.SDR{temperatureSDR(0x20)}, err: types.NewResponseError(types.CodeRequestedDataNotPresent, "missing")}
	got, err := readSensors(context.Background(), f)
	if err != nil || got[0].State != "unavailable" {
		t.Fatalf("%+v %v", got, err)
	}
	f.err = context.DeadlineExceeded
	if _, err = readSensors(context.Background(), f); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
func TestSensorCancellationAndNonlinearConversion(t *testing.T) {
	f := &sensorFixture{records: []*types.SDR{temperatureSDR(0x20)}, reading: &sensor.GetSensorReadingResponse{Reading: 21}}
	f.records[0].Full.LinearizationFunc = 0x70
	got, err := readSensors(context.Background(), f)
	if err != nil || got[0].Value != "42" {
		t.Fatalf("%+v %v", got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = readSensors(ctx, f); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestCompactSensorPreservesDiscreteHealth(t *testing.T) {
	f := &sensorFixture{records: []*types.SDR{{RecordHeader: &types.SDRHeader{RecordType: types.SDRRecordTypeCompactSensor}, Compact: &types.SDRCompact{
		GeneratorID: 0x20, SensorNumber: 2, IDStringBytes: []byte("PS1 Status"), SensorType: types.SensorTypePowerSupply, SensorEventReadingType: types.EventReadingTypeSensorSpecific,
	}}}, reading: &sensor.GetSensorReadingResponse{ActiveStates: types.Mask_DiscreteEvent{State_0: true, State_1: true}}}
	got, err := readSensors(context.Background(), f)
	if err != nil || got[0].State != "critical" || got[0].Unit != "" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestMalformedSensorInputFailsClosed(t *testing.T) {
	for _, records := range [][]*types.SDR{nil, {nil}, {{RecordHeader: &types.SDRHeader{RecordType: types.SDRRecordTypeFullSensor}}}} {
		if _, err := readSensors(context.Background(), &sensorFixture{records: records}); err == nil {
			t.Fatal("malformed repository accepted")
		}
	}
	f := &sensorFixture{records: []*types.SDR{temperatureSDR(0x20)}}
	if _, err := readSensors(context.Background(), f); err == nil {
		t.Fatal("nil response accepted")
	}
}
