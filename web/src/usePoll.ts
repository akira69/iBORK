import { useEffect, useState } from "react";
import { api } from "./api";

export function usePoll<T>(
  path: string,
  interval: number,
  enabled = true,
  revision = 0,
  retainDataOnError = false,
) {
  const [result, setResult] = useState<{
    data?: T;
    error?: string;
    received: number;
    revision: number;
    loading: boolean;
  }>({ loading: true, received: 0, revision });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false,
      busy = false;
    const controller = new AbortController();
    const load = async () => {
      if (disposed || busy || document.hidden) return;
      busy = true;
      try {
        const data = await api<T>(path, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(65000),
          ]),
        });
        if (!disposed)
          setResult({
            data,
            loading: false,
            received: performance.now(),
            revision,
          });
      } catch (error) {
        if (!disposed)
          setResult((previous) => ({
            data: retainDataOnError ? previous.data : undefined,
            received: previous.received,
            revision,
            error: error instanceof Error ? error.message : "Unavailable",
            loading: false,
          }));
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = interval
      ? setInterval(() => void load(), interval)
      : undefined;
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [path, interval, enabled, revision, retainDataOnError]);
  return result;
}
