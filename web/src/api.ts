export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(65000),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "login" && path !== "session")
      window.dispatchEvent(new Event("session-expired"));
    throw new APIError(data.error ?? "Request failed", response.status);
  }
  return data as T;
}
export function mutate(path: string, action: string, csrf: string) {
  return api(path, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
    body: JSON.stringify({ action, confirm: action }),
  });
}
