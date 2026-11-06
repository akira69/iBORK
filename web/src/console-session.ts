import type { ConsoleSource } from "./device-identity";
export type ConsoleKey = `${string}:${ConsoleSource}`;
export type ConsolePhase =
  | "disconnected"
  | "connecting"
  | "live"
  | "no-signal"
  | "busy"
  | "failed"
  | "reconnecting"
  | "superseded";
export type ConsoleFailure =
  "transient" | "auth" | "certificate" | "busy" | "superseded";
export type ConsoleSnapshot = { phase: ConsolePhase; error?: string };
export interface ConsoleAdapter {
  connect(signal: AbortSignal): Promise<void>;
  disconnect(): void;
  setInputEnabled(enabled: boolean): void;
  release(): void;
}
const disconnected: ConsoleSnapshot = Object.freeze({ phase: "disconnected" });
type Entry = {
  adapter: ConsoleAdapter;
  snapshot: ConsoleSnapshot;
  wanted: boolean;
  running: boolean;
  generation: number;
  retries: number;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
};

export class ConsoleSessionStore {
  private entries = new Map<ConsoleKey, Entry>();
  private listeners = new Set<() => void>();
  private queue: ConsoleKey[] = [];
  private attempts = 0;
  private control: ConsoleKey | null = null;
  private closed = false;
  register(key: ConsoleKey, adapter: ConsoleAdapter) {
    if (this.closed) return () => {};
    if (this.entries.has(key)) this.disconnect(key);
    const entry: Entry = {
      adapter,
      snapshot: disconnected,
      wanted: false,
      running: false,
      generation: 0,
      retries: 0,
    };
    this.entries.set(key, entry);
    return () => {
      if (this.entries.get(key) === entry) {
        this.disconnect(key);
        this.entries.delete(key);
        this.emit();
      }
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (key: ConsoleKey) =>
    this.entries.get(key)?.snapshot ?? disconnected;
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private update(entry: Entry, snapshot: ConsoleSnapshot) {
    if (
      entry.snapshot.phase === snapshot.phase &&
      entry.snapshot.error === snapshot.error
    )
      return;
    entry.snapshot = snapshot;
    this.emit();
  }
  connect(key: ConsoleKey) {
    const entry = this.entries.get(key);
    if (this.closed || !entry || entry.wanted) return;
    entry.wanted = true;
    entry.retries = 0;
    this.enqueue(key, entry);
  }
  private enqueue(key: ConsoleKey, entry: Entry) {
    if (!entry.wanted || this.closed) return;
    this.queue.push(key);
    this.update(entry, {
      phase: entry.retries ? "reconnecting" : "connecting",
    });
    this.drain();
  }
  private drain() {
    while (!this.closed && this.attempts < 2 && this.queue.length) {
      const key = this.queue.shift()!,
        entry = this.entries.get(key);
      if (!entry?.wanted || entry.running) continue;
      const generation = ++entry.generation;
      const controller = (entry.controller = new AbortController());
      entry.running = true;
      this.attempts++;
      entry.adapter.setInputEnabled(false);
      entry.timer = setTimeout(
        () =>
          this.report(
            key,
            { phase: "failed", error: "Console connection timed out." },
            "transient",
          ),
        15000,
      );
      try {
        Promise.resolve(entry.adapter.connect(controller.signal)).then(
          () => {
            if (
              entry.generation === generation &&
              entry.wanted &&
              !this.closed &&
              entry.running
            )
              this.report(key, { phase: "live" });
          },
          () => {
            if (entry.generation === generation && entry.wanted && !this.closed)
              this.report(
                key,
                { phase: "failed", error: "Console connection failed." },
                "transient",
              );
          },
        );
      } catch {
        this.report(
          key,
          { phase: "failed", error: "Console connection failed." },
          "transient",
        );
      }
    }
  }
  private finishAttempt(entry: Entry) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.running) {
      entry.running = false;
      this.attempts--;
    }
  }
  report(key: ConsoleKey, snapshot: ConsoleSnapshot, failure?: ConsoleFailure) {
    const entry = this.entries.get(key);
    if (this.closed || !entry?.wanted) return;
    if (failure) {
      // Invalidate the adapter before abort/cleanup can synchronously report back.
      entry.wanted = false;
      entry.generation++;
      if (this.control === key) this.setControl(null);
      this.finishAttempt(entry);
      entry.controller?.abort();
      entry.adapter.release();
      entry.adapter.setInputEnabled(false);
      entry.adapter.disconnect();
      this.queue = this.queue.filter((item) => item !== key);
      if (failure === "transient" && entry.retries < 3) {
        const delay = 1000 * 2 ** entry.retries++;
        entry.wanted = true;
        this.update(entry, { phase: "reconnecting", error: snapshot.error });
        entry.retry = setTimeout(() => this.enqueue(key, entry), delay);
      } else this.update(entry, snapshot);
      this.drain();
      return;
    }
    if (this.control === key && snapshot.phase !== entry.snapshot.phase)
      this.setControl(null);
    if (snapshot.phase === "live" || snapshot.phase === "no-signal") {
      this.finishAttempt(entry);
      entry.retries = 0;
    }
    this.update(entry, snapshot);
    this.drain();
  }
  setControl(key: ConsoleKey | null) {
    if (key === this.control) return;
    const previous = this.control && this.entries.get(this.control);
    this.control = null;
    if (previous) {
      previous.adapter.release();
      previous.adapter.setInputEnabled(false);
    }
    const next = key && this.entries.get(key);
    if (
      next &&
      ["live", "no-signal"].includes(next.snapshot.phase) &&
      next.wanted &&
      !this.closed
    ) {
      this.control = key;
      next.adapter.setInputEnabled(true);
    }
    this.emit();
  }
  isControlling = (key: ConsoleKey) => this.control === key;
  disconnect(key: ConsoleKey) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.wanted = false;
    entry.generation++;
    if (this.control === key) this.setControl(null);
    this.queue = this.queue.filter((item) => item !== key);
    clearTimeout(entry.retry);
    this.finishAttempt(entry);
    entry.controller?.abort();
    entry.adapter.release();
    entry.adapter.setInputEnabled(false);
    entry.adapter.disconnect();
    this.update(entry, disconnected);
    this.drain();
  }
  close() {
    this.closed = true;
    this.queue = [];
    for (const key of this.entries.keys()) this.disconnect(key);
  }
}
