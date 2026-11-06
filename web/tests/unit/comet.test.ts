import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CometProvider } from "../../src/comet";

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 1;
  sent: Array<{ channel: string; data: Record<string, unknown> }> = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor(public url: URL) {
    Socket.all.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  message(channel: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ channel, data }) });
  }
}
class Peer {
  static all: Peer[] = [];
  connectionState = "connected";
  framesDecoded = 0;
  localDescription = { type: "answer", sdp: "fixture" };
  ontrack?: (e: { track: unknown }) => void;
  onicecandidate?: (e: { candidate: unknown }) => void;
  onconnectionstatechange?: () => void;
  constructor() {
    Peer.all.push(this);
  }
  async setRemoteDescription() {}
  async createAnswer() {
    return this.localDescription;
  }
  async setLocalDescription() {}
  async addIceCandidate() {}
  async getStats() {
    return new Map([
      [
        "video",
        {
          type: "inbound-rtp",
          kind: "video",
          framesDecoded: this.framesDecoded,
        },
      ],
    ]);
  }
  close() {
    this.connectionState = "closed";
  }
}
let provider: CometProvider;
let phase = vi.fn<(phase: string) => void>();
let failure = vi.fn<(reason: string) => void>();
let abort: AbortController;
const flush = async () => {
  for (let n = 0; n < 15; n++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  Peer.all = [];
  phase = vi.fn();
  failure = vi.fn();
  abort = new AbortController();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("window", { location: { href: "https://ibork.example/" } });
  vi.stubGlobal("MediaStream", class {});
  provider = new CometProvider(
    { phase, failure, stream: vi.fn() },
    "devices/comet/",
  );
});
afterEach(() => {
  provider.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function negotiate() {
  const promise = provider.connect(abort.signal);
  void promise.catch(() => {});
  const ws = Socket.all[0];
  ws.onopen?.();
  ws.message("janus", { janus: "success", data: { id: 1 } });
  ws.message("janus", { janus: "success", data: { id: 2 } });
  ws.message("janus", {
    janus: "event",
    jsep: { type: "offer", sdp: "fixture" },
  });
  await flush();
  return { ws, promise };
}
it("uses same-origin signaling and waits for decoded frames instead of ICE alone", async () => {
  const { ws, promise } = await negotiate();
  expect(String(ws.url)).toBe(
    "wss://ibork.example/api/devices/comet/glkvm/session",
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(phase).not.toHaveBeenCalledWith("live");
  Peer.all[0].framesDecoded = 2;
  await vi.advanceTimersByTimeAsync(1000);
  await promise;
  expect(phase).toHaveBeenCalledWith("live");
});
it("recognizes explicit no_signal even when source.online is true, then recovers to video", async () => {
  const { ws, promise } = await negotiate();
  ws.message("events", {
    event_type: "streamer",
    event: {
      streamer: { source: { online: true, real_resolution: "no_signal" } },
    },
  });
  await flush();
  await promise;
  expect(phase).toHaveBeenLastCalledWith("no-signal");
  ws.message("events", {
    event_type: "streamer",
    event: {
      streamer: { source: { online: true, real_resolution: "1920x1080" } },
    },
  });
  Peer.all[0].framesDecoded = 3;
  await vi.advanceTimersByTimeAsync(1000);
  expect(phase).toHaveBeenLastCalledWith("no-signal");
  Peer.all[0].framesDecoded = 4;
  await vi.advanceTimersByTimeAsync(1000);
  expect(phase).toHaveBeenLastCalledWith("live");
});
it("sends only focused keyboard input and releases held keys before disconnect", async () => {
  const { ws } = await negotiate();
  provider.key("KeyA", true);
  expect(ws.sent.filter((m) => m.channel === "events")).toHaveLength(0);
  provider.setInputEnabled(true);
  provider.key("KeyA", true);
  provider.key("KeyA", true);
  provider.key("invalid", true);
  provider.disconnect();
  expect(
    ws.sent.filter((m) => m.data.event_type === "key").map((m) => m.data.event),
  ).toEqual([
    { key: "KeyA", state: true, finish: false },
    { key: "KeyA", state: false, finish: false },
  ]);
  expect(Peer.all[0].connectionState).toBe("closed");
});

it("ignores in-flight frame counts across signal recovery and requires new progress", async () => {
  const { ws, promise } = await negotiate();
  const source = (missing: boolean) =>
    ws.message("events", {
      event_type: "streamer",
      event: {
        streamer: {
          source: {
            online: true,
            real_resolution: missing ? "no_signal" : "1920x1080",
          },
        },
      },
    });
  source(true);
  await flush();
  await promise;
  const peer = Peer.all[0];
  let complete!: (value: Awaited<ReturnType<Peer["getStats"]>>) => void;
  vi.spyOn(peer, "getStats").mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  source(false);
  await flush();
  complete(
    new Map([
      ["video", { type: "inbound-rtp", kind: "video", framesDecoded: 5 }],
    ]),
  );
  await flush();
  expect(phase).toHaveBeenLastCalledWith("no-signal");
  peer.framesDecoded = 5;
  await vi.advanceTimersByTimeAsync(2000);
  expect(phase).toHaveBeenLastCalledWith("no-signal");
  peer.framesDecoded = 6;
  await vi.advanceTimersByTimeAsync(1000);
  expect(phase).toHaveBeenLastCalledWith("live");
});
it.each([
  [4401, "auth"],
  [4403, "certificate"],
  [4409, "busy"],
  [4404, "auth"],
  [1008, "auth"],
])("treats close %s as terminal %s", async (code, reason) => {
  const { ws, promise } = await negotiate();
  ws.onclose?.({ code: Number(code) });
  await expect(promise).rejects.toThrow();
  expect(failure).toHaveBeenCalledWith(reason);
});
it("bounds an idle handshake and a stalled stream even with repeated online metadata", async () => {
  const { ws, promise } = await negotiate();
  for (let n = 0; n < 15; n++) {
    ws.message("events", {
      event_type: "streamer",
      event: {
        streamer: { source: { online: true, real_resolution: "1920x1080" } },
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
  }
  await expect(promise).rejects.toThrow();
  expect(failure).toHaveBeenCalledWith("transient");
});
it("keeps no-signal sessions alive and releases keys when input is disabled", async () => {
  const { ws, promise } = await negotiate();
  ws.message("events", {
    event_type: "streamer",
    event: { streamer: { source: { online: false } } },
  });
  await flush();
  await promise;
  await vi.advanceTimersByTimeAsync(20000);
  expect(failure).not.toHaveBeenCalled();
  provider.setInputEnabled(true);
  provider.key("ShiftLeft", true);
  provider.setInputEnabled(false);
  provider.key("KeyA", true);
  expect(
    ws.sent.filter((m) => m.data.event_type === "key").map((m) => m.data.event),
  ).toEqual([
    { key: "ShiftLeft", state: true, finish: false },
    { key: "ShiftLeft", state: false, finish: false },
  ]);
});

it("times out a recovered signal whose decoded frame count stays frozen", async () => {
  const { ws, promise } = await negotiate();
  ws.message("events", {
    event_type: "streamer",
    event: { streamer: { source: { online: false } } },
  });
  await flush();
  await promise;
  ws.message("events", {
    event_type: "streamer",
    event: {
      streamer: { source: { online: true, real_resolution: "1920x1080" } },
    },
  });
  Peer.all[0].framesDecoded = 20;
  await vi.advanceTimersByTimeAsync(16000);
  expect(phase).not.toHaveBeenCalledWith("live");
  expect(failure).toHaveBeenCalledWith("transient");
});
it("cancels pending handshakes and ignores late stream events", async () => {
  const { ws, promise } = await negotiate();
  const late = ws.onmessage;
  abort.abort();
  await expect(promise).rejects.toThrow();
  phase.mockClear();
  late?.({
    data: JSON.stringify({
      channel: "events",
      data: {
        event_type: "streamer",
        event: { streamer: { source: { online: false } } },
      },
    }),
  });
  expect(phase).not.toHaveBeenCalled();
});
