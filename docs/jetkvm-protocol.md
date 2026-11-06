# Stock JetKVM protocol

Inspected upstream https://github.com/jetkvm/kvm commit
`d646be873a136f1d7c2ec743e6fe826e43c65b30`.
The browser client adapts `ui/src/webrtc/signaling/useWebSocketSignaling.ts`,
`routes/devices.$id.tsx`, `hooks/{hidRpc,useHidRpc,useMouse,useJsonRpc}.ts`
and `keyboardMappings.ts`. Firmware stays stock.

The backend logs into JetKVM and relays its `/webrtc/signaling/client` WebSocket
through authenticated, same-origin `/api/jetkvm/signaling`. No upstream password
or session cookie is returned to the browser. Media and data channels use direct
WebRTC; only signaling crosses the app backend. LAN routing between browser and
JetKVM is required (no TURN configuration in this first client).

1. Device sends `{type:"device-metadata",data:{deviceVersion:...}}`.
2. Browser adds receive-only video/audio transceivers and `rpc` / `hidrpc` data
   channels, then sends `{type:"offer",data:{sd:base64(JSON.stringify(localDescription))}}`.
3. Device answers `{type:"answer",data:base64(JSON.stringify(description))}`.
4. Both send `{type:"new-ice-candidate",data:RTCIceCandidateInit}`. The client
   holds incoming candidates until the remote description is set, and sends
   locally gathered candidates after the offer.
5. Text `ping` / `pong` keeps signaling alive. Takeover signaling event
   `other-session-connected`, RPC `otherSessionConnected`, or socket close 4001
   ends the connection in `superseded`; only explicit Connect/Reconnect resumes.
   Relay policy close 1008 or 4401 ends it in `failed` (login expired).

RPC channel messages use JSON-RPC 2.0 `{jsonrpc:"2.0",id,method,params}`;
`rpc()` resolves the response `result`, rejects remote errors and 10-second
request timeouts. Notifications call the constructor callback. Every disconnect
rejects outstanding requests and drops media. Connection attempts time out in
20 seconds, retry up to six times with 500ms exponential backoff capped at 10s.
HID handshake retries each second, failing after ten attempts. Stale callbacks
and async continuations cannot affect a replacement session.

HID v1 handshake is bytes `[1,1]` in both directions. Keyboard reports are
`[2,modifier,...keys]` using USB HID usage codes and at most six nonmodifier keys;
modifier bits are left Ctrl/Shift/Alt/GUI then right Ctrl/Shift/Alt/GUI. Absolute
pointer reports are `[3,x:int32BE,y:int32BE,buttons:uint8]`, x/y in 0..32767.
DOM button bits map directly. All reports use the reliable ordered `hidrpc`
channel; optional unreliable movement channels and relative pointer mode are
omitted. Wheel uses RPC `wheelReport` with `{wheelY,wheelX:0}`; positive browser
Y becomes negative HID Y, clamped to 127 steps. Blur and disconnect send empty
keyboard and released mouse-button reports while the transport is available.
Network loss can prevent delivery; device disconnect cleanup is also necessary.
The UI must normalize pointer coordinates to the displayed video content area,
excluding letterbox bars, and capture browser KeyboardEvent.code only when the
console owns focus. Browser-reserved shortcuts may remain unavailable.

## EDID and virtual media RPC

| Method | Params | Result |
| --- | --- | --- |
| `getEDIDPresets` | `{}` | `Array<{name:string,edid:string}>` |
| `getEDID` | `{}` | EDID hex string |
| `setEDID` | `{edid:hexString}` | success acknowledgement; re-read for verification |
| `getVirtualMediaState` | `{}` | `null` if ejected, otherwise object below |
| `mountWithHTTP` | `{url:string,mode:"CDROM"\|"Disk"}` | success acknowledgement |
| `mountWithStorage` | `{filename:string,mode:"CDROM"\|"Disk"}` | success acknowledgement |
| `unmountImage` | `{}` | success acknowledgement |

Actual Go `VirtualMediaState` wire shape (`usb_mass_storage.go`):
`{source:"HTTP"|"Storage",mode:"CDROM"|"Disk",size:number,filename?:string,url?:string}`.
Do not assume the frontend store's additional `path` property exists on the wire.
RPC errors and unsupported firmware capabilities must remain visible to the user.

`edid_presets.go` offers the named `DELL IDRAC EDID, 1280x1024` preset. Fetch it
from the device, require explicit user action, then pass its exact `edid` to
`setEDID`; never silently alter EDID or substitute a guessed preset. Older
firmware may lack `getEDIDPresets`. Availability is not hardware qualification
of an individual adapter/display mode.

HTTP virtual media uses a URL reachable by JetKVM and upstream network-block
storage, with HTTP range/size requirements enforced by stock firmware. It is
not browser-local upload. Storage mount requires a file already on JetKVM.
Browser upload datachannel/chunk orchestration is deliberately omitted. ISO
mount and EDID changes require user confirmation in the UI and hardware tests
remain manual. Inspect `jsonrpc.go` method registry for version-specific method
availability; the generic RPC transport intentionally does not duplicate it.
