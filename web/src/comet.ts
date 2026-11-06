import { keyCodes } from "./hid";
import type { ConsoleFailure } from "./console-session";

export class CometProvider {
  private ws?: WebSocket;
  private peer?: RTCPeerConnection;
  private generation = 0;
  private session?: number;
  private handle?: number;
  private timer?: ReturnType<typeof setInterval>;
  private cancel?: () => void;
  private reject?: (error: Error) => void;
  private enabled = false;
  private held = new Set<string>();
  constructor(
    private callbacks: {
      phase: (phase: "live" | "no-signal") => void;
      failure: (reason: ConsoleFailure) => void;
      stream: (stream: MediaStream | null) => void;
    },
    private prefix: string,
  ) {}

  connect(signal: AbortSignal): Promise<void> {
    this.disconnect();
    if (signal.aborted)
      return Promise.reject(new Error("Connection cancelled"));
    const generation = this.generation;
    const current = () => generation === this.generation;
    const url = new URL(
      `/api/${this.prefix}glkvm/session`,
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = (this.ws = new WebSocket(url));
    const peer = (this.peer = new RTCPeerConnection());
    let noSignal = false,
      signalVersion = 0,
      needsBaseline = false,
      frames = 0,
      idle = 0,
      ticks = 0,
      checking = false;
    const fail = (reason: ConsoleFailure = "transient") => {
      if (!current()) return;
      this.disconnect();
      this.callbacks.failure(reason);
    };
    return new Promise<void>((resolve, reject) => {
      this.reject = reject;
      const ready = (phase: "live" | "no-signal") => {
        if (!current()) return;
        this.callbacks.phase(phase);
        this.reject = undefined;
        resolve();
      };
      const abort = () => this.disconnect();
      signal.addEventListener("abort", abort, { once: true });
      this.cancel = () => signal.removeEventListener("abort", abort);
      ws.onopen = () => {
        if (current()) this.janus({ janus: "create" });
      };
      ws.onclose = (event) =>
        fail(
          [4401, 4404, 1008].includes(event.code)
            ? "auth"
            : event.code === 4403
              ? "certificate"
              : event.code === 4409
                ? "busy"
                : "transient",
        );
      ws.onerror = () => fail();
      let messages = Promise.resolve();
      ws.onmessage = (event) => {
        messages = messages
          .then(async () => {
            if (!current()) return;
            const { channel, data } = JSON.parse(event.data);
            if (channel === "events") {
              const source =
                data.event_type === "streamer" && data.event?.streamer?.source;
              if (source) {
                const nextNoSignal =
                  source.online === false ||
                  source.real_resolution === "no_signal";
                if (nextNoSignal !== noSignal) {
                  idle = 0;
                  signalVersion++;
                  needsBaseline = !nextNoSignal;
                }
                noSignal = nextNoSignal;
                if (noSignal) ready("no-signal");
              }
              return;
            }
            if (channel !== "janus") return;
            if (
              data.janus === "error" ||
              data.janus === "hangup" ||
              data.janus === "detached" ||
              data.plugindata?.data?.error
            ) {
              fail();
              return;
            }
            if (data.janus === "success" && data.data?.id) {
              if (!this.session) {
                this.session = data.data.id;
                this.janus({
                  janus: "attach",
                  plugin: "janus.plugin.ustreamer",
                });
              } else if (!this.handle) {
                this.handle = data.data.id;
                this.janus({ janus: "message", body: { request: "features" } });
                this.janus({
                  janus: "message",
                  body: {
                    request: "watch",
                    params: {
                      orientation: 0,
                      audio: false,
                      video: true,
                      mic: false,
                      camera: false,
                      video_format: 0,
                    },
                  },
                });
              }
            }
            if (data.jsep) {
              await peer.setRemoteDescription(data.jsep);
              if (!current()) return;
              const answer = await peer.createAnswer();
              if (!current()) return;
              await peer.setLocalDescription(answer);
              if (current())
                this.janus({
                  janus: "message",
                  body: { request: "start" },
                  jsep: peer.localDescription,
                });
            }
            if (
              data.janus === "trickle" &&
              data.candidate &&
              !data.candidate.completed
            )
              await peer.addIceCandidate(data.candidate);
          })
          .catch(() => fail());
      };
      peer.ontrack = (event) => {
        if (current()) this.callbacks.stream(new MediaStream([event.track]));
      };
      peer.onicecandidate = (event) => {
        if (current())
          this.janus({
            janus: "trickle",
            candidate: event.candidate?.toJSON() ?? { completed: true },
          });
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") fail();
      };
      this.timer = setInterval(async () => {
        if (!current() || checking) return;
        checking = true;
        try {
          if (++ticks % 5 === 0) {
            if (this.session) this.janus({ janus: "keepalive" });
            this.send("events", { event_type: "ping", event: {} });
          }
          const sampledVersion = signalVersion;
          const stats = await peer.getStats();
          if (!current() || sampledVersion !== signalVersion) return;
          let decoded = 0;
          stats.forEach((stat) => {
            if (stat.type === "inbound-rtp" && stat.kind === "video")
              decoded += stat.framesDecoded ?? 0;
          });
          if (needsBaseline) {
            frames = decoded;
            needsBaseline = false;
          } else if (decoded > frames) {
            frames = decoded;
            idle = 0;
            if (!noSignal) ready("live");
          } else if (!noSignal && ++idle >= 15) fail();
        } catch {
          fail();
        } finally {
          checking = false;
        }
      }, 1000);
    });
  }
  private send(channel: "janus" | "events", data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ channel, data }));
  }
  private janus(data: Record<string, unknown>) {
    this.send("janus", {
      ...data,
      transaction: crypto.randomUUID(),
      ...(this.session ? { session_id: this.session } : {}),
      ...(this.handle && data.janus !== "keepalive"
        ? { handle_id: this.handle }
        : {}),
    });
  }
  setInputEnabled(enabled: boolean) {
    if (!enabled) this.release();
    this.enabled = enabled;
  }
  key(code: string, down: boolean) {
    if (
      !this.enabled ||
      !Object.hasOwn(keyCodes, code) ||
      down === this.held.has(code)
    )
      return;
    if (down) this.held.add(code);
    else this.held.delete(code);
    this.send("events", {
      event_type: "key",
      event: { key: code, state: down, finish: false },
    });
  }
  release() {
    for (const key of this.held)
      this.send("events", {
        event_type: "key",
        event: { key, state: false, finish: false },
      });
    this.held.clear();
  }
  disconnect() {
    this.generation++;
    this.release();
    this.enabled = false;
    this.cancel?.();
    this.cancel = undefined;
    clearInterval(this.timer);
    if (this.ws) {
      this.ws.onclose =
        this.ws.onerror =
        this.ws.onmessage =
        this.ws.onopen =
          null;
      this.ws.close();
      this.ws = undefined;
    }
    this.peer?.close();
    this.peer = undefined;
    this.session = this.handle = undefined;
    this.callbacks.stream(null);
    this.reject?.(new Error("Comet connection closed"));
    this.reject = undefined;
  }
}
