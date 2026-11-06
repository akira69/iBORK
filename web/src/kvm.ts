// SPDX-License-Identifier: GPL-2.0-only
// Stock protocol adapted from jetkvm/kvm, see THIRD_PARTY_NOTICES.md.
import type { ConsoleFailure } from "./console-session";
import { keyCodes, pointer } from "./hid";
export type KVMState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "no-signal"
  | "reconnecting"
  | "superseded"
  | "failed";
type Callbacks = {
  failure?: (reason: ConsoleFailure) => void;
  state: (state: KVMState) => void;
  stream: (stream: MediaStream | null) => void;
  notification?: (event: string, params: unknown) => void;
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class JetKVMProvider {
  private ws?: WebSocket;
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private hid?: RTCDataChannel;
  private hidReady = false;
  private keys = new Set<number>();
  private inputEnabled = false;
  setInputEnabled(enabled: boolean) {
    if (!enabled) this.release();
    this.inputEnabled = enabled;
  }
  private position = [0, 0];
  private generation = 0;
  private counter = 0;
  private pending = new Map<number, Pending>();
  private deadline?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private handshake?: ReturnType<typeof setInterval>;
  private mediaMonitor?: ReturnType<typeof setInterval>;
  private mediaVisibility?: () => void;
  private videoState?: (value: unknown) => void;
  constructor(
    private callbacks: Callbacks,
    private apiPrefix = "",
  ) {}
  connect(): void {
    this.start();
  }
  reconnect(): void {
    this.connect();
  }
  disconnect(): void {
    this.cleanup();
    this.callbacks.state("disconnected");
  }
  private cleanup(): void {
    this.release();
    this.generation++;
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    clearInterval(this.handshake);
    clearInterval(this.mediaMonitor);
    if (this.mediaVisibility)
      document.removeEventListener("visibilitychange", this.mediaVisibility);
    this.mediaVisibility = undefined;
    this.videoState = undefined;
    window.removeEventListener("blur", this.release);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("KVM disconnected"));
    }
    this.pending.clear();
    const ws = this.ws,
      pc = this.pc;
    this.ws = undefined;
    this.pc = undefined;
    this.channel = undefined;
    this.hid = undefined;
    this.hidReady = false;
    ws?.close();
    pc?.close();
    this.callbacks.stream(null);
  }
  private stop(state: KVMState): void {
    this.cleanup();
    this.callbacks.state(state);
    this.callbacks.failure?.(state === "superseded" ? "superseded" : "auth");
  }
  private failure(generation: number): void {
    if (generation !== this.generation) return;
    this.cleanup();
    this.callbacks.state("failed");
    this.callbacks.failure?.("transient");
  }
  private start(): void {
    this.cleanup();
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.callbacks.state("connecting");
    window.addEventListener("blur", this.release);
    this.deadline = setTimeout(() => this.failure(generation), 15000);
    try {
      const url = new URL(
        `/api/${this.apiPrefix}jetkvm/signaling`,
        window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = (this.ws = new WebSocket(url));
      ws.onopen = () => {
        if (current())
          this.heartbeat = setInterval(() => {
            try {
              if (ws.readyState === WebSocket.OPEN) ws.send("ping");
            } catch {
              this.failure(generation);
            }
          }, 10000);
      };
      ws.onclose = (event) => {
        if (!current()) return;
        if (event.code === 4403 || event.code === 4409) {
          this.cleanup();
          this.callbacks.state("failed");
          this.callbacks.failure?.(
            event.code === 4403 ? "certificate" : "busy",
          );
        } else if (event.code === 4001) this.stop("superseded");
        else if (event.code === 1008 || event.code === 4401)
          this.stop("failed");
        else this.failure(generation);
      };
      ws.onerror = () => this.failure(generation);
      let incoming = Promise.resolve();
      ws.onmessage = (event) => {
        if (!current() || event.data === "pong") return;
        incoming = incoming
          .then(async () => {
            if (!current()) return;
            const message = JSON.parse(event.data);
            if (message.type === "other-session-connected") {
              this.stop("superseded");
              return;
            }
            if (message.type === "device-metadata" && !this.pc)
              await this.offer(generation);
            if (!current()) return;
            const pc = this.pc;
            if (!pc) return;
            if (message.type === "answer")
              await pc.setRemoteDescription(JSON.parse(atob(message.data)));
            if (message.type === "new-ice-candidate") {
              if (pc.remoteDescription) await pc.addIceCandidate(message.data);
              else candidates.push(message.data);
            }
            if (current() && pc.remoteDescription)
              while (candidates.length && current())
                await pc.addIceCandidate(candidates.shift()!);
          })
          .catch(() => this.failure(generation));
      };
      const candidates: RTCIceCandidateInit[] = [];
    } catch {
      this.failure(generation);
    }
  }
  private async offer(generation: number): Promise<void> {
    const current = () => generation === this.generation;
    const pc = (this.pc = new RTCPeerConnection());
    const stream = new MediaStream();
    let decoded: number | null = 0;
    let lastFrameAt = Date.now(),
      sampling = false,
      reported = false,
      noSignal = false,
      hasVideo = false,
      mediaRevision = 0;
    const ready = () => {
      if (
        !current() ||
        reported ||
        (!hasVideo && !noSignal) ||
        pc.connectionState !== "connected" ||
        this.channel?.readyState !== "open" ||
        !this.hidReady
      )
        return;
      clearTimeout(this.deadline);
      reported = true;
      this.callbacks.stream(noSignal ? null : stream);
      this.callbacks.state(noSignal ? "no-signal" : "connected");
    };
    this.videoState = (value) => {
      if (!current() || !value || typeof value !== "object") return;
      const status = value as { ready?: unknown; error?: unknown };
      if (status.ready === false && status.error === "no_signal") {
        if (!noSignal) {
          reported = false;
          mediaRevision++;
        }
        hasVideo = false;
        noSignal = true;
        ready();
      } else if (typeof status.ready === "boolean" && noSignal) {
        noSignal = false;
        reported = false;
        decoded = null;
        mediaRevision++;
        lastFrameAt = Date.now();
        this.callbacks.state("connecting");
        clearTimeout(this.deadline);
        this.deadline = setTimeout(() => this.failure(generation), 15000);
      }
    };
    const sample = async () => {
      if (!current() || noSignal) return;
      if (document.hidden) {
        lastFrameAt = Date.now();
        return;
      }
      if (hasVideo && Date.now() - lastFrameAt >= 15000) {
        this.failure(generation);
        return;
      }
      if (sampling) return;
      sampling = true;
      const revision = mediaRevision;
      try {
        const stats = await pc.getStats();
        if (!current() || revision !== mediaRevision) return;
        let frames = 0;
        stats.forEach((stat) => {
          if (
            stat.type === "inbound-rtp" &&
            stat.kind === "video" &&
            Number.isFinite(stat.framesDecoded)
          )
            frames += stat.framesDecoded;
        });
        // Recovery counters are cumulative; establish a baseline before trusting progress.
        if (decoded === null) {
          decoded = frames;
          return;
        }
        if (frames > 0 && frames !== decoded) {
          decoded = frames;
          hasVideo = true;
          lastFrameAt = Date.now();
          ready();
        }
      } catch {
        if (revision === mediaRevision) this.failure(generation);
      } finally {
        sampling = false;
      }
    };
    this.mediaVisibility = () => {
      lastFrameAt = Date.now();
    };
    document.addEventListener("visibilitychange", this.mediaVisibility);
    this.mediaMonitor = setInterval(() => void sample(), 1000);
    pc.ontrack = (event) => {
      if (current()) {
        stream.addTrack(event.track);
        this.callbacks.stream(stream);
      }
    };
    pc.onconnectionstatechange = () => {
      if (!current()) return;
      ready();
      void sample();
      if (["failed", "disconnected", "closed"].includes(pc.connectionState))
        this.failure(generation);
    };
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    const rpc = (this.channel = pc.createDataChannel("rpc"));
    rpc.onopen = ready;
    rpc.onmessage = (event) => {
      if (current()) this.receive(event.data);
    };
    rpc.onclose = () => this.failure(generation);
    const hid = (this.hid = pc.createDataChannel("hidrpc"));
    hid.binaryType = "arraybuffer";
    hid.onopen = () => {
      if (!current()) return;
      let attempts = 0;
      const hello = () => {
        if (!current() || hid.readyState !== "open") return;
        if (++attempts > 10) {
          this.failure(generation);
          return;
        }
        try {
          hid.send(new Uint8Array([1, 1]));
        } catch {
          this.failure(generation);
        }
      };
      hello();
      if (current()) this.handshake = setInterval(hello, 1000);
    };
    hid.onmessage = (event) => {
      if (!current()) return;
      const data = new Uint8Array(event.data);
      if (data[0] === 1) {
        if (data[1] !== 1) {
          this.stop("failed");
          return;
        }
        clearInterval(this.handshake);
        this.hidReady = true;
        ready();
      }
    };
    hid.onclose = () => this.failure(generation);
    const localCandidates: RTCIceCandidate[] = [];
    let offered = false;
    pc.onicecandidate = (event) => {
      if (!current() || !event.candidate?.candidate) return;
      if (offered) this.signal("new-ice-candidate", event.candidate);
      else localCandidates.push(event.candidate);
    };
    const offer = await pc.createOffer();
    if (!current()) return;
    await pc.setLocalDescription(offer);
    if (!current()) return;
    this.signal("offer", { sd: btoa(JSON.stringify(pc.localDescription)) });
    offered = true;
    for (const candidate of localCandidates)
      this.signal("new-ice-candidate", candidate);
  }
  private signal(type: string, data: unknown): void {
    this.ws?.send(JSON.stringify({ type, data }));
  }
  private receive(data: string): void {
    try {
      const message = JSON.parse(data);
      if (typeof message.method === "string") {
        if (message.method === "videoInputState")
          this.videoState?.(message.params);
        if (message.method === "otherSessionConnected") this.stop("superseded");
        this.callbacks.notification?.(message.method, message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error(message.error.message || "JetKVM RPC failed"));
      else pending.resolve(message.result);
    } catch {
      /* Ignore malformed unsolicited messages. */
    }
  }
  rpc<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const channel = this.channel;
    if (channel?.readyState !== "open")
      return Promise.reject(new Error("KVM RPC unavailable"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("KVM RPC timeout"));
      }, 10000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        channel.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("KVM RPC send failed"));
      }
    });
  }
  private send(data: Uint8Array<ArrayBuffer>): void {
    if (this.hidReady && this.hid?.readyState === "open") {
      try {
        this.hid.send(data);
      } catch {
        this.hidReady = false;
        this.failure(this.generation);
      }
    }
  }
  key(code: string, down: boolean): void {
    if (!this.inputEnabled) return;
    const key = keyCodes[code];
    if (key === undefined || !this.hidReady) return;
    if (down) this.keys.add(key);
    else this.keys.delete(key);
    let modifier = 0;
    for (const key of this.keys)
      if (key >= 224 && key <= 231) modifier |= 1 << (key - 224);
    const keys = [...this.keys].filter((key) => key < 224);
    // USB boot keyboards report at most six simultaneous nonmodifier keys.
    this.send(
      new Uint8Array([
        2,
        modifier,
        ...(keys.length > 6 ? Array<number>(6).fill(1) : keys),
      ]),
    );
  }
  mouse(x: number, y: number, buttons: number): void {
    if (!this.inputEnabled) return;
    if (![x, y, buttons].every(Number.isFinite)) return;
    this.position = [x, y];
    this.send(pointer(x, y, buttons));
  }
  wheel(deltaY: number): void {
    if (!this.inputEnabled) return;
    if (Number.isFinite(deltaY) && deltaY)
      void this.rpc("wheelReport", {
        wheelY: -Math.max(
          -127,
          Math.min(
            127,
            Math.round(
              Math.abs(deltaY) >= 100 ? deltaY / 100 : Math.sign(deltaY),
            ),
          ),
        ),
        wheelX: 0,
      }).catch(() => undefined);
  }
  release = (): void => {
    this.keys.clear();
    this.send(new Uint8Array([2, 0]));
    this.send(pointer(this.position[0], this.position[1], 0));
  };
}
