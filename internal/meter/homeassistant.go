package meter

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/akira69/iBORK/internal/energy"
	"github.com/akira69/iBORK/internal/telemetryhttp"
)

var sensorEntity = regexp.MustCompile(`^sensor\.[a-z0-9_]+$`)

type HomeAssistant struct {
	url, entity, token string
	client             *http.Client
	now                func() time.Time
}

func ValidateHomeAssistant(endpoint, entity string) error {
	u, err := origin(endpoint)
	if err != nil || u.Scheme != "https" {
		return errors.New("enter an HTTPS Home Assistant server URL")
	}
	if len(entity) > 255 || !sensorEntity.MatchString(entity) {
		return errors.New("enter the sensor.entity_id for the power sensor")
	}
	return nil
}

func NewHomeAssistant(endpoint, entity, token string) (*HomeAssistant, error) {
	if err := ValidateHomeAssistant(endpoint, entity); err != nil {
		return nil, err
	}
	if !telemetryhttp.ValidBearer(token) {
		return nil, errors.New("enter a Home Assistant token")
	}
	return &HomeAssistant{url: strings.TrimSuffix(endpoint, "/") + "/api/states/" + entity, entity: entity, token: token, client: telemetryhttp.NewClient(timeout), now: time.Now}, nil
}

func (h *HomeAssistant) Read(ctx context.Context) (energy.Sample, error) {
	var state struct {
		Entity     string    `json:"entity_id"`
		State      string    `json:"state"`
		At         time.Time `json:"last_reported"`
		Attributes struct {
			Class      string `json:"device_class"`
			StateClass string `json:"state_class"`
			Unit       string `json:"unit_of_measurement"`
			Restored   bool   `json:"restored"`
		} `json:"attributes"`
	}
	if err := telemetryhttp.GetJSON(ctx, h.client, h.url, h.token, &state); err != nil {
		return energy.Sample{}, err
	}
	watts, err := strconv.ParseFloat(state.State, 64)
	attr := state.Attributes
	if err != nil || state.Entity != h.entity || attr.Restored || attr.Class != "power" || (attr.StateClass != "" && attr.StateClass != "measurement") {
		return energy.Sample{}, errors.New("Home Assistant has no active-power measurement for this sensor")
	}
	switch attr.Unit {
	case "kW":
		watts *= 1000
	case "W":
	default:
		return energy.Sample{}, errors.New("Home Assistant power sensor must report W or kW")
	}
	return observation(watts, state.At, h.now())
}
