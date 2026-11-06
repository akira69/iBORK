package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
)

const cometMessageLimit = 256 * 1024

var errCometProtocol = errors.New("unsupported console message")
var cometKey = regexp.MustCompile(`^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma)|Control(Left|Right)|Alt(Left|Right)|Shift(Left|Right)|Meta(Left|Right)|Arrow(Left|Right|Up|Down)|Backspace|Tab|Enter|Escape|Space|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|CapsLock|NumLock|ScrollLock|Insert|Delete|Home|End|PageUp|PageDown|PrintScreen|Pause|ContextMenu|IntlBackslash|IntlRo|IntlYen)$`)

type cometEnvelope struct {
	Channel string          `json:"channel"`
	Data    json.RawMessage `json:"data"`
}

type cometKeyEvent struct {
	Type  string `json:"event_type"`
	Event struct {
		Key    string `json:"key"`
		State  *bool  `json:"state"`
		Finish bool   `json:"finish"`
	} `json:"event"`
}

func cometDecode(data []byte, into any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(into); err != nil {
		return errCometProtocol
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return errCometProtocol
	}
	return nil
}

// Re-encoding validated messages removes duplicate JSON fields before forwarding.
func cometJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

type cometJanus struct {
	Janus       string          `json:"janus"`
	Transaction string          `json:"transaction"`
	SessionID   uint64          `json:"session_id,omitempty"`
	HandleID    uint64          `json:"handle_id,omitempty"`
	Plugin      string          `json:"plugin,omitempty"`
	OpaqueID    string          `json:"opaque_id,omitempty"`
	Body        json.RawMessage `json:"body,omitempty"`
	JSEP        json.RawMessage `json:"jsep,omitempty"`
	Candidate   json.RawMessage `json:"candidate,omitempty"`
}

type cometProtocol struct {
	create, attach  string
	session, handle uint64
	held            map[string]bool
}

func (p *cometProtocol) janusInput(data []byte) ([]byte, error) {
	var m cometJanus
	if cometDecode(data, &m) != nil || len(m.Transaction) == 0 || len(m.Transaction) > 80 {
		return nil, errCometProtocol
	}
	if m.Janus != "attach" && (m.Plugin != "" || m.OpaqueID != "") ||
		m.Janus != "message" && (len(m.Body) != 0 || len(m.JSEP) != 0) ||
		m.Janus != "trickle" && len(m.Candidate) != 0 {
		return nil, errCometProtocol
	}
	if m.Janus == "create" {
		if p.create != "" || m.SessionID != 0 || m.HandleID != 0 {
			return nil, errCometProtocol
		}
		p.create = m.Transaction
		return cometJSON(m), nil
	}
	if p.session == 0 || m.SessionID != p.session {
		return nil, errCometProtocol
	}
	switch m.Janus {
	case "attach":
		if p.attach != "" || m.Transaction == p.create || m.HandleID != 0 || m.Plugin != "janus.plugin.ustreamer" || len(m.OpaqueID) > 80 {
			return nil, errCometProtocol
		}
		p.attach = m.Transaction
	case "keepalive", "destroy":
		if m.HandleID != 0 {
			return nil, errCometProtocol
		}
	case "message", "trickle", "detach", "hangup":
		if p.handle == 0 || m.HandleID != p.handle {
			return nil, errCometProtocol
		}
		if m.Janus == "message" {
			body, jsep, err := cometPluginInput(m.Body, m.JSEP)
			if err != nil {
				return nil, err
			}
			m.Body, m.JSEP = body, jsep
		}
		if m.Janus == "trickle" {
			var candidate struct {
				Candidate        string  `json:"candidate,omitempty"`
				SDPMid           *string `json:"sdpMid,omitempty"`
				SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
				UsernameFragment *string `json:"usernameFragment,omitempty"`
				Completed        bool    `json:"completed,omitempty"`
			}
			if cometDecode(m.Candidate, &candidate) != nil ||
				len(candidate.Candidate) > 4096 || (!candidate.Completed && !strings.HasPrefix(candidate.Candidate, "candidate:")) ||
				(candidate.Completed && candidate.Candidate != "") {
				return nil, errCometProtocol
			}
			m.Candidate = cometJSON(candidate)
		}
	default:
		return nil, errCometProtocol
	}
	return cometJSON(m), nil
}

func cometPluginInput(data, answer json.RawMessage) (json.RawMessage, json.RawMessage, error) {
	var body struct {
		Request string `json:"request"`
		Params  *struct {
			Orientation int  `json:"orientation"`
			Audio       bool `json:"audio"`
			Video       bool `json:"video"`
			Mic         bool `json:"mic"`
			Camera      bool `json:"camera"`
			VideoFormat int  `json:"video_format"`
		} `json:"params,omitempty"`
	}
	if cometDecode(data, &body) != nil {
		return nil, nil, errCometProtocol
	}
	if body.Request != "watch" && body.Params != nil || body.Request != "start" && len(answer) != 0 {
		return nil, nil, errCometProtocol
	}
	switch body.Request {
	case "features", "stop", "key_required":
	case "watch":
		p := body.Params
		if p == nil || p.Orientation != 0 || p.Audio || !p.Video || p.Mic || p.Camera || p.VideoFormat != 0 {
			return nil, nil, errCometProtocol
		}
	case "start":
		var jsep struct {
			Type string `json:"type"`
			SDP  string `json:"sdp"`
		}
		if cometDecode(answer, &jsep) != nil || jsep.Type != "answer" || !strings.HasPrefix(jsep.SDP, "v=0") || len(jsep.SDP) > 128*1024 || strings.Contains(jsep.SDP, "a=sendrecv") || strings.Contains(jsep.SDP, "a=sendonly") {
			return nil, nil, errCometProtocol
		}
		answer = cometJSON(jsep)
	default:
		return nil, nil, errCometProtocol
	}
	return cometJSON(body), answer, nil
}

func (p *cometProtocol) janusOutput(data []byte) error {
	var m struct {
		Janus       string `json:"janus"`
		Transaction string `json:"transaction"`
		Data        struct {
			ID uint64 `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &m) != nil {
		return errCometProtocol
	}
	if m.Janus == "success" && m.Data.ID > 0 {
		if m.Transaction == p.create && p.create != "" && p.session == 0 {
			p.session = m.Data.ID
		} else if m.Transaction == p.attach && p.attach != "" && p.handle == 0 {
			p.handle = m.Data.ID
		}
	}
	return nil
}
