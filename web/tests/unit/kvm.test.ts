import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { JetKVMProvider } from "../../src/kvm";
import { keyCodes, pointer } from "../../src/hid";
class Channel {
  readyState = "open";
  binaryType = "";
  sent: unknown[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  send(data: unknown) {
    this.sent.push(data);
  }
}
class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(public url: URL) {
    Socket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  message(type: string, data: unknown = {}) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
class Peer {
  static all: Peer[] = [];
  connectionState = "new";
  framesDecoded = 1;
  freeze = false;
  async getStats() {
    return new Map([
      [
        "video",
        {
          type: "inbound-rtp",
          kind: "video",
          framesDecoded: this.freeze
            ? this.framesDecoded
            : ++this.framesDecoded,
        },
      ],
    ]);
  }
  localDescription: unknown;
  remoteDescription: unknown;
  channels: Record<string, Channel> = {};
  ice: unknown[] = [];
  onconnectionstatechange?: () => void;
  onicecandidate?: (event: { candidate: { candidate: string } }) => void;
  ontrack?: (event: { track: unknown }) => void;
  constructor() {
    Peer.all.push(this);
  }
  addTransceiver() {}
  createDataChannel(name: string) {
    return (this.channels[name] = new Channel());
  }
  async createOffer() {
    return { type: "offer", sdp: "test" };
  }
  async setLocalDescription(offer: unknown) {
    this.onicecandidate?.({ candidate: { candidate: "local" } });
    this.localDescription = offer;
  }
  async setRemoteDescription(answer: unknown) {
    this.remoteDescription = answer;
  }
  async addIceCandidate(candidate: unknown) {
    this.ice.push(candidate);
  }
  close() {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
let provider: JetKVMProvider;
let state: ReturnType<typeof vi.fn<(state: string) => void>>;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  Peer.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal(
    "MediaStream",
    class {
      addTrack() {}
    },
  );
  vi.stubGlobal("window", {
    location: { href: "https://console.example/" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "hidden", {
    value: false,
    configurable: true,
  });
  vi.stubGlobal("document", documentTarget);
  state = vi.fn();
  provider = new JetKVMProvider({ state, stream: vi.fn() });
});
afterEach(() => {
  provider.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function connected(framesDecoded = 1) {
  provider.setInputEnabled(true);
  provider.connect();
  const ws = Socket.all[0];
  ws.onopen?.();
  ws.message("device-metadata");
  await flush();
  const pc = Peer.all[0];
  pc.framesDecoded = framesDecoded;
  pc.freeze = framesDecoded === 0;
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  pc.channels.hidrpc.onopen?.();
  pc.channels.hidrpc.onmessage?.({ data: new Uint8Array([1, 1]).buffer });
  await flush();
  return { ws, pc, hid: pc.channels.hidrpc, rpc: pc.channels.rpc };
}
it("offers base64 SDP before local ICE and queues remote ICE until answer", async () => {
  const { ws, pc } = await connected();
  expect(ws.url.href).toBe("wss://console.example/api/jetkvm/signaling");
  const messages = ws.sent.map((value) => JSON.parse(value));
  expect(messages.map((value) => value.type)).toEqual([
    "offer",
    "new-ice-candidate",
  ]);
  expect(JSON.parse(atob(messages[0].data.sd))).toEqual({
    type: "offer",
    sdp: "test",
  });
  ws.message("new-ice-candidate", { candidate: "remote" });
  await flush();
  expect(pc.ice).toEqual([]);
  ws.message("answer", btoa(JSON.stringify({ type: "answer", sdp: "remote" })));
  await flush();
  expect(pc.ice).toEqual([{ candidate: "remote" }]);
  expect(state).toHaveBeenLastCalledWith("connected");
});
it("encodes HID, modifiers, pointer bounds, wheel and release", async () => {
  const { hid, rpc } = await connected();
  expect(hid.sent[0]).toEqual(new Uint8Array([1, 1]));
  provider.key("ControlLeft", true);
  provider.key("KeyA", true);
  expect(hid.sent.at(-1)).toEqual(new Uint8Array([2, 1, 4]));
  provider.mouse(1, 0.5, 1);
  const bytes = hid.sent.at(-1) as Uint8Array;
  expect(new DataView(bytes.buffer).getInt32(1)).toBe(32767);
  expect(new DataView(bytes.buffer).getInt32(5)).toBe(16384);
  provider.wheel(100);
  expect(JSON.parse(rpc.sent[0] as string).params).toEqual({
    wheelY: -1,
    wheelX: 0,
  });
  provider.release();
  expect(hid.sent.at(-2)).toEqual(new Uint8Array([2, 0]));
  expect((hid.sent.at(-1) as Uint8Array)[9]).toBe(0);
  expect(keyCodes.F24).toBe(115);
  expect(pointer(-1, 2, 255)[9]).toBe(31);
});
it("resolves RPC and rejects remote errors", async () => {
  const { rpc } = await connected();
  const request = provider.rpc("getEDID");
  rpc.onmessage?.({ data: "{" });
  rpc.onmessage?.({ data: JSON.stringify({ id: 1, result: "EDID" }) });
  await expect(request).resolves.toBe("EDID");
  const bad = provider.rpc("bad");
  rpc.onmessage?.({
    data: JSON.stringify({ id: 2, error: { message: "unsupported" } }),
  });
  await expect(bad).rejects.toThrow("unsupported");
});
it("rejects timed-out RPC and pending RPC on disconnect", async () => {
  await connected();
  const request = provider.rpc("slow");
  const check = expect(request).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(10000);
  await check;
  const pending = provider.rpc("pending");
  const rejected = expect(pending).rejects.toThrow("disconnected");
  provider.disconnect();
  await rejected;
  await expect(provider.rpc("offline")).rejects.toThrow("unavailable");
});
it("reports errors without retrying and ignores retired callbacks", async () => {
  const { ws, pc } = await connected();
  ws.onerror?.();
  expect(state).toHaveBeenLastCalledWith("failed");
  await vi.advanceTimersByTimeAsync(500);
  expect(Socket.all).toHaveLength(1);
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  ws.message("device-metadata");
  await flush();
  expect(Peer.all).toHaveLength(1);
  expect(state).toHaveBeenLastCalledWith("failed");
  provider.disconnect();
  await vi.advanceTimersByTimeAsync(60000);
  expect(Socket.all).toHaveLength(1);
});
it.each(["close", "signal", "rpc"])(
  "does not fight takeover via %s",
  async (method) => {
    const { ws, rpc } = await connected();
    if (method === "close") ws.onclose?.({ code: 4001 });
    if (method === "signal") ws.message("other-session-connected");
    if (method === "rpc")
      rpc.onmessage?.({
        data: JSON.stringify({ method: "otherSessionConnected", params: {} }),
      });
    await flush();
    expect(state).toHaveBeenLastCalledWith("superseded");
    await vi.advanceTimersByTimeAsync(60000);
    expect(Socket.all).toHaveLength(1);
    provider.reconnect();
    expect(Socket.all).toHaveLength(2);
  },
);
it("bounds failed connection attempts", async () => {
  provider.connect();
  await vi.advanceTimersByTimeAsync(20000);
  expect(state).toHaveBeenLastCalledWith("failed");
  await vi.advanceTimersByTimeAsync(180000);
  expect(state).toHaveBeenLastCalledWith("failed");
});
it("stops when relay session authorization expires", async () => {
  await connected();
  Socket.all[0].onclose?.({ code: 1008 });
  expect(state).toHaveBeenLastCalledWith("failed");
  await vi.advanceTimersByTimeAsync(60000);
  expect(Socket.all).toHaveLength(1);
});
it("guards an asynchronous offer retired by disconnect", async () => {
  let finish!: (value: { type: string; sdp: string }) => void;
  vi.spyOn(Peer.prototype, "createOffer").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  provider.connect();
  Socket.all[0].message("device-metadata");
  await flush();
  provider.disconnect();
  finish({ type: "offer", sdp: "late" });
  await flush();
  expect(Socket.all[0].sent).toEqual([]);
});

it("times out missing HID negotiation even if media connected", async () => {
  provider.connect();
  Socket.all[0].message("device-metadata");
  await flush();
  const pc = Peer.all[0];
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  pc.channels.hidrpc.onopen?.();
  await vi.advanceTimersByTimeAsync(11000);
  expect(state).toHaveBeenLastCalledWith("failed");
});
it("rejects send failures and reconnects on malformed signaling", async () => {
  const { rpc, ws } = await connected();
  vi.spyOn(rpc, "send").mockImplementation(() => {
    throw new Error("closed");
  });
  await expect(provider.rpc("getEDID")).rejects.toThrow("send failed");
  ws.onmessage?.({ data: "{" });
  await flush();
  expect(state).toHaveBeenLastCalledWith("failed");
});
it("releases input on blur and rejects a failed HID transport without recursion", async () => {
  const { hid } = await connected();
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.find((call) => call[0] === "blur")?.[1];
  expect(listener).toBe(provider.release);
  provider.key("KeyB", true);
  provider.release();
  expect(hid.sent.at(-2)).toEqual(new Uint8Array([2, 0]));
  vi.spyOn(hid, "send").mockImplementation(() => {
    throw new Error("closed");
  });
  expect(() => provider.key("KeyA", true)).not.toThrow();
  expect(state).toHaveBeenLastCalledWith("failed");
});
it("keeps setup deadline when media connects but HID never opens", async () => {
  provider.connect();
  Socket.all[0].message("device-metadata");
  await flush();
  const pc = Peer.all[0];
  pc.channels.hidrpc.readyState = "connecting";
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  expect(state).not.toHaveBeenCalledWith("connected");
  await vi.advanceTimersByTimeAsync(20000);
  expect(state).toHaveBeenLastCalledWith("failed");
});
it("does not retry a failed HID handshake without its session owner", async () => {
  provider.connect();
  Socket.all[0].message("device-metadata");
  await flush();
  const pc = Peer.all[0];
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  pc.channels.hidrpc.onopen?.();
  await vi.advanceTimersByTimeAsync(90000);
  expect(state).not.toHaveBeenCalledWith("connected");
  expect(state).toHaveBeenLastCalledWith("failed");
  expect(Socket.all).toHaveLength(1);
});
it.each(["media-first", "hid-first"])(
  "requires media, RPC and HID readiness in %s order",
  async (order) => {
    provider.connect();
    Socket.all[0].message("device-metadata");
    await flush();
    const pc = Peer.all[0];
    const rpc = pc.channels.rpc;
    rpc.readyState = "connecting";
    const media = () => {
      pc.connectionState = "connected";
      pc.onconnectionstatechange?.();
    };
    const hid = () => {
      pc.channels.hidrpc.onopen?.();
      pc.channels.hidrpc.onmessage?.({ data: new Uint8Array([1, 1]).buffer });
    };
    if (order === "media-first") {
      media();
      hid();
    } else {
      hid();
      media();
    }
    expect(state).not.toHaveBeenCalledWith("connected");
    rpc.readyState = "open";
    rpc.onopen?.();
    await flush();
    expect(state).toHaveBeenLastCalledWith("connected");
    await vi.advanceTimersByTimeAsync(21000);
    expect(state).toHaveBeenLastCalledWith("connected");
  },
);
it("completes when media is the last prerequisite", async () => {
  provider.connect();
  Socket.all[0].message("device-metadata");
  await flush();
  const pc = Peer.all[0];
  pc.channels.rpc.onopen?.();
  pc.channels.hidrpc.onopen?.();
  pc.channels.hidrpc.onmessage?.({ data: new Uint8Array([1, 1]).buffer });
  expect(state).not.toHaveBeenCalledWith("connected");
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  await flush();
  expect(state).toHaveBeenLastCalledWith("connected");
});
it("keeps setup deadline if RPC never opens despite media and HID readiness", async () => {
  provider.connect();
  Socket.all[0].message("device-metadata");
  await flush();
  const pc = Peer.all[0];
  pc.channels.rpc.readyState = "connecting";
  pc.channels.hidrpc.onopen?.();
  pc.channels.hidrpc.onmessage?.({ data: new Uint8Array([1, 1]).buffer });
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  expect(state).not.toHaveBeenCalledWith("connected");
  await vi.advanceTimersByTimeAsync(20000);
  expect(state).toHaveBeenLastCalledWith("failed");
});

it("does not report live before a decoded video frame", async () => {
  await connected(0);
  expect(state).not.toHaveBeenCalledWith("connected");
  await vi.advanceTimersByTimeAsync(15000);
  expect(state).toHaveBeenLastCalledWith("failed");
});
it("detects frozen decoded video while data channels remain open", async () => {
  const { pc } = await connected();
  await vi.advanceTimersByTimeAsync(1000);
  pc.freeze = true;
  await vi.advanceTimersByTimeAsync(15000);
  expect(state).toHaveBeenLastCalledWith("failed");
});

it("ignores retired media stats and does not mistake a background pause for a frozen stream", async () => {
  const { pc } = await connected();
  Object.defineProperty(document, "hidden", {
    value: true,
    configurable: true,
  });
  pc.freeze = true;
  await vi.advanceTimersByTimeAsync(60000);
  expect(state).toHaveBeenLastCalledWith("connected");
  Object.defineProperty(document, "hidden", {
    value: false,
    configurable: true,
  });
  pc.freeze = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(state).toHaveBeenLastCalledWith("connected");
  let finish!: (value: Awaited<ReturnType<Peer["getStats"]>>) => void;
  vi.spyOn(pc, "getStats").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  provider.disconnect();
  finish(
    new Map([
      ["video", { type: "inbound-rtp", kind: "video", framesDecoded: 999 }],
    ]),
  );
  await flush();
  expect(state).toHaveBeenLastCalledWith("disconnected");
});

it("gives video time to resume after background timer suspension", async () => {
  const { pc } = await connected();
  pc.freeze = true;
  vi.setSystemTime(Date.now() + 60000);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(state).toHaveBeenLastCalledWith("connected");
});

it("keeps confirmed no-signal connected for keyboard wake and recovers video", async () => {
  const { pc, rpc, hid } = await connected(0);
  rpc.onmessage?.({
    data: JSON.stringify({
      method: "videoInputState",
      params: { ready: false, error: "no_signal" },
    }),
  });
  expect(state).toHaveBeenLastCalledWith("no-signal");
  await vi.advanceTimersByTimeAsync(60000);
  expect(pc.connectionState).toBe("connected");
  provider.key("KeyA", true);
  expect(hid.sent.at(-1)).toEqual(new Uint8Array([2, 0, 4]));
  rpc.onmessage?.({
    data: JSON.stringify({
      method: "videoInputState",
      params: { ready: true },
    }),
  });
  expect(state).toHaveBeenLastCalledWith("connecting");
  pc.freeze = false;
  await vi.advanceTimersByTimeAsync(2000);
  expect(state).toHaveBeenLastCalledWith("connected");
});
it("does not infer no-signal from unrecognized video status", async () => {
  const { rpc } = await connected(0);
  rpc.onmessage?.({
    data: JSON.stringify({
      method: "videoInputState",
      params: { ready: false, error: "no_lock" },
    }),
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(state).toHaveBeenLastCalledWith("failed");
});

it("clears confirmed no-signal when the device reports a different video fault", async () => {
  const { rpc } = await connected(0);
  for (const error of ["no_signal", "no_lock"]) {
    rpc.onmessage?.({
      data: JSON.stringify({
        method: "videoInputState",
        params: { ready: false, error },
      }),
    });
  }
  expect(state).toHaveBeenLastCalledWith("connecting");
  await vi.advanceTimersByTimeAsync(15000);
  expect(state).toHaveBeenLastCalledWith("failed");
});

it("requires fresh decoded progress after a previously live source recovers", async () => {
  const { pc, rpc } = await connected();
  pc.freeze = true;
  for (const params of [{ ready: false, error: "no_signal" }, { ready: true }])
    rpc.onmessage?.({
      data: JSON.stringify({ method: "videoInputState", params }),
    });
  await vi.advanceTimersByTimeAsync(2000);
  expect(state).toHaveBeenLastCalledWith("connecting");
  pc.freeze = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(state).toHaveBeenLastCalledWith("connected");
});

it("replaces the original deadline when signal recovers before peer readiness", async () => {
  provider.connect();
  Socket.all[0].message("device-metadata");
  await flush();
  const pc = Peer.all[0];
  for (const params of [{ ready: false, error: "no_signal" }, { ready: true }])
    pc.channels.rpc.onmessage?.({
      data: JSON.stringify({ method: "videoInputState", params }),
    });
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  pc.channels.hidrpc.onopen?.();
  pc.channels.hidrpc.onmessage?.({ data: new Uint8Array([1, 1]).buffer });
  await vi.advanceTimersByTimeAsync(20000);
  expect(state).toHaveBeenLastCalledWith("connected");
});

it("ignores in-flight video counters across signal transitions and bounds frozen recovery", async () => {
  const { pc, rpc } = await connected();
  pc.freeze = true;
  let finish!: (value: Awaited<ReturnType<Peer["getStats"]>>) => void;
  vi.spyOn(pc, "getStats").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  for (const params of [{ ready: false, error: "no_signal" }, { ready: true }])
    rpc.onmessage?.({
      data: JSON.stringify({ method: "videoInputState", params }),
    });
  finish(
    new Map([
      ["video", { type: "inbound-rtp", kind: "video", framesDecoded: 999 }],
    ]),
  );
  await flush();
  await vi.advanceTimersByTimeAsync(2000);
  expect(state).toHaveBeenLastCalledWith("connecting");
  await vi.advanceTimersByTimeAsync(13000);
  expect(state).toHaveBeenLastCalledWith("failed");
});
