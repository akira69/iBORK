package management

import (
	"context"
	"errors"
	"math"
	"strings"

	"github.com/bougou/go-ipmi/pkg/client"
	"github.com/bougou/go-ipmi/pkg/command/sensor"
	"github.com/bougou/go-ipmi/pkg/types"
)

type sensorReader interface {
	GetSDRsRaw(context.Context, ...types.SDRRecordType) ([]*types.SDR, error)
	GetSensorReading(context.Context, uint8) (*sensor.GetSensorReadingResponse, error)
	GetSensorReadingFactors(context.Context, uint8, uint8) (*sensor.GetSensorReadingFactorsResponse, error)
}

// Read current values once; upstream GetSensors also reads unused thresholds and software-owned SDRs.
func readSensors(ctx context.Context, c sensorReader) ([]Sensor, error) {
	records, err := c.GetSDRsRaw(ctx, types.SDRRecordTypeFullSensor, types.SDRRecordTypeCompactSensor)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, errors.New("no sensors available")
	}
	out := make([]Sensor, 0, len(records))
	for _, record := range records {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		s := sensorMetadata(record)
		if s == nil {
			return nil, errors.New("invalid sensor record")
		}
		// Software owners emit events; they are not IPMB addresses that accept reads.
		if !s.GeneratorID.OwnerIsSystemSoftware() {
			command := (&client.CommandContext{}).WithResponderAddr(s.GeneratorID.OwnerID()).WithResponderLUN(s.GeneratorID.LUN())
			if err := readSensor(client.WithCommandContext(ctx, command), c, s); err != nil {
				return nil, err
			}
		}
		out = append(out, sensorView(s))
	}
	return out, nil
}

func sensorMetadata(record *types.SDR) *types.Sensor {
	if record == nil || record.RecordHeader == nil {
		return nil
	}
	s := &types.Sensor{SDRRecordType: record.RecordHeader.RecordType}
	switch {
	case s.SDRRecordType == types.SDRRecordTypeFullSensor && record.Full != nil:
		r := record.Full
		s.GeneratorID, s.Number, s.Name = r.GeneratorID, uint8(r.SensorNumber), strings.TrimSpace(string(r.IDStringBytes))
		s.SensorUnit, s.SensorType, s.EventReadingType = r.SensorUnit, r.SensorType, r.SensorEventReadingType
		s.Threshold.LinearizationFunc, s.Threshold.ReadingFactors = r.LinearizationFunc, r.ReadingFactors
	case s.SDRRecordType == types.SDRRecordTypeCompactSensor && record.Compact != nil:
		r := record.Compact
		s.GeneratorID, s.Number, s.Name = r.GeneratorID, uint8(r.SensorNumber), strings.TrimSpace(string(r.IDStringBytes))
		s.SensorUnit, s.SensorType, s.EventReadingType = r.SensorUnit, r.SensorType, r.SensorEventReadingType
	default:
		return nil
	}
	s.HasAnalogReading = record.HasAnalogReading()
	return s
}

func readSensor(ctx context.Context, c sensorReader, s *types.Sensor) error {
	r, err := c.GetSensorReading(ctx, s.Number)
	if err != nil {
		if e, ok := types.IsResponseError(err); ok {
			switch e.CompletionCode() {
			case types.CodeRequestedDataNotPresent, types.CodeIllegalCommand, types.CodeInvalidCommand:
				return nil
			}
		}
		return err
	}
	if r == nil {
		return errors.New("missing sensor response")
	}
	s.ScanningDisabled, s.ReadingAvailable = r.SensorScanningDisabled, !r.ReadingUnavailable
	if s.ScanningDisabled || !s.ReadingAvailable {
		return nil
	}
	if s.HasAnalogReading && s.Threshold.LinearizationFunc.IsNonLinear() {
		factors, err := c.GetSensorReadingFactors(ctx, s.Number, r.Reading)
		if err != nil {
			return err
		}
		if factors == nil {
			return errors.New("missing sensor conversion factors")
		}
		s.Threshold.ReadingFactors = factors.ReadingFactors
	}
	s.Raw, s.Value = r.Reading, s.ConvertReading(r.Reading)
	if math.IsNaN(s.Value) || math.IsInf(s.Value, 0) {
		s.ReadingAvailable = false
	}
	s.Threshold.ThresholdStatus = r.ThresholdStatus()
	s.Discrete.ActiveStates, s.Discrete.OptionalData1, s.Discrete.OptionalData2 = r.ActiveStates, r.OptionalData1, r.OptionalData2
	return nil
}
