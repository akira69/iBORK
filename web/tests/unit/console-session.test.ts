import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleSessionStore,
  type ConsoleAdapter,
} from "../../src/console-session";

function adapter() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const connect = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((yes, no) => {
        expect(signal.aborted).toBe(false);
        resolve = yes;
        reject = no;
      }),
  );
  const value: ConsoleAdapter = {
    connect,
    disconnect: vi.fn(),
    release: vi.fn(),
    setInputEnabled: vi.fn(),
  };
  return {
    value,
    connect,
    ready: () => resolve(),
    fail: () => reject(new Error("offline")),
  };
}
describe("console session ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("limits_connection_attempts", async () => {
    const store = new ConsoleSessionStore(),
      a = adapter(),
      b = adapter(),
      c = adapter();
    store.register("a:vnc", a.value);
    store.register("b:vnc", b.value);
    store.register("c:vnc", c.value);
    store.connect("a:vnc");
    store.connect("b:vnc");
    store.connect("c:vnc");
    expect(c.connect).not.toHaveBeenCalled();
    a.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.connect).toHaveBeenCalledTimes(1);
    store.close();
  });
  it("manual_disconnect_cancels_queue", async () => {
    const store = new ConsoleSessionStore(),
      a = adapter(),
      b = adapter(),
      c = adapter();
    store.register("a:vnc", a.value);
    store.register("b:vnc", b.value);
    store.register("c:vnc", c.value);
    store.connect("a:vnc");
    store.connect("b:vnc");
    store.connect("c:vnc");
    store.disconnect("c:vnc");
    a.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.connect).not.toHaveBeenCalled();
    store.disconnect("b:vnc");
    expect(b.connect.mock.calls[0][0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(c.connect).not.toHaveBeenCalled();
    store.close();
  });
  it("late_connect_cannot_revive_closed_session", async () => {
    const store = new ConsoleSessionStore(),
      a = adapter();
    store.register("a:vnc", a.value);
    store.connect("a:vnc");
    store.close();
    a.ready();
    store.report("a:vnc", { phase: "live" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot("a:vnc").phase).toBe("disconnected");
    expect(a.connect.mock.calls[0][0].aborted).toBe(true);
  });
  it("only_one_console_accepts_input", async () => {
    const store = new ConsoleSessionStore(),
      a = adapter(),
      b = adapter();
    store.register("a:vnc", a.value);
    store.register("b:vnc", b.value);
    store.connect("a:vnc");
    store.connect("b:vnc");
    a.ready();
    b.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.setControl("a:vnc");
    store.setControl("b:vnc");
    expect(a.value.release).toHaveBeenCalled();
    expect(a.value.setInputEnabled).toHaveBeenLastCalledWith(false);
    expect(b.value.setInputEnabled).toHaveBeenLastCalledWith(true);
    const aDisable = vi
      .mocked(a.value.setInputEnabled)
      .mock.invocationCallOrder.at(-1)!;
    const bEnable = vi
      .mocked(b.value.setInputEnabled)
      .mock.invocationCallOrder.at(-1)!;
    expect(aDisable).toBeLessThan(bEnable);
    store.close();
  });
  it("terminal_failures_do_not_retry", async () => {
    for (const failure of [
      "auth",
      "certificate",
      "busy",
      "superseded",
    ] as const) {
      const store = new ConsoleSessionStore(),
        a = adapter();
      store.register("a:vnc", a.value);
      store.connect("a:vnc");
      store.report(
        "a:vnc",
        {
          phase:
            failure === "busy" || failure === "superseded" ? failure : "failed",
        },
        failure,
      );
      await vi.advanceTimersByTimeAsync(60000);
      expect(a.connect).toHaveBeenCalledTimes(1);
      store.close();
    }
  });
  it("attempt_deadline_and_three_bounded_retries", async () => {
    const store = new ConsoleSessionStore(),
      a = adapter();
    store.register("a:vnc", a.value);
    store.connect("a:vnc");
    await vi.advanceTimersByTimeAsync(14999);
    expect(a.connect.mock.calls[0][0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.connect.mock.calls[0][0].aborted).toBe(true);
    for (const [index, delay] of [1000, 2000, 4000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(a.connect).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(a.connect).toHaveBeenCalledTimes(index + 2);
      await vi.advanceTimersByTimeAsync(15000);
    }
    expect(store.getSnapshot("a:vnc").phase).toBe("failed");
    await vi.advanceTimersByTimeAsync(60000);
    expect(a.connect).toHaveBeenCalledTimes(4);
    store.close();
  });
  it("reconnect_requires_refocus", async () => {
    const store = new ConsoleSessionStore(),
      a = adapter();
    store.register("a:vnc", a.value);
    store.connect("a:vnc");
    a.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.setControl("a:vnc");
    store.report("a:vnc", { phase: "failed" }, "transient");
    expect(a.value.setInputEnabled).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1000);
    a.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.value.setInputEnabled).toHaveBeenLastCalledWith(false);
    store.report("a:vnc", { phase: "failed" }, "transient");
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.connect).toHaveBeenCalledTimes(3);
    store.close();
  });
  it("unchanged_snapshots_keep_identity_and_disconnect_cancels_retry", async () => {
    const store = new ConsoleSessionStore(),
      a = adapter();
    store.register("a:vnc", a.value);
    expect(store.getSnapshot("a:vnc")).toBe(store.getSnapshot("a:vnc"));
    store.connect("a:vnc");
    a.fail();
    await vi.advanceTimersByTimeAsync(0);
    store.disconnect("a:vnc");
    await vi.advanceTimersByTimeAsync(10000);
    expect(a.connect).toHaveBeenCalledTimes(1);
    store.close();
  });
});

it("allows deliberate no-signal control and releases it when video returns", async () => {
  const store = new ConsoleSessionStore(),
    a = adapter();
  store.register("a:jetkvm", a.value);
  store.connect("a:jetkvm");
  store.report("a:jetkvm", { phase: "no-signal" });
  a.ready();
  await Promise.resolve();
  expect(store.getSnapshot("a:jetkvm").phase).toBe("no-signal");
  store.setControl("a:jetkvm");
  expect(store.isControlling("a:jetkvm")).toBe(true);
  store.report("a:jetkvm", { phase: "connecting" });
  expect(store.isControlling("a:jetkvm")).toBe(false);
  store.close();
});
