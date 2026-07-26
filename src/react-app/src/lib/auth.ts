import { useState, useEffect, useCallback } from "react";

export interface AuthState {
  username: string;
  role: string;
}

let cached: AuthState | null | undefined;
let fetchPromise: Promise<AuthState | null> | null = null;

/** Basic Auth header built from sessionStorage credentials (set by LoginScreen). */
export function basicAuthHeader(): Record<string, string> {
  const user = sessionStorage.getItem("dva_user");
  const pass = sessionStorage.getItem("dva_pass");
  if (!user || !pass) return {};
  return { Authorization: "Basic " + btoa(`${user}:${pass}`) };
}

/** Persist credentials and invalidate the cached auth state. */
export function storeCredentials(username: string, password: string): void {
  sessionStorage.setItem("dva_user", username);
  sessionStorage.setItem("dva_pass", password);
  cached = undefined;
}

/** Drop credentials (logout) and invalidate the cached auth state. */
export function clearCredentials(): void {
  sessionStorage.removeItem("dva_user");
  sessionStorage.removeItem("dva_pass");
  cached = undefined;
}

async function fetchMe(): Promise<AuthState | null> {
  if (fetchPromise) return fetchPromise;
  fetchPromise = (async () => {
    try {
      // Attach stored credentials — on loopback dev the host resolves the
      // user from this header (the proxy only passes "loopback" through).
      const resp = await fetch("/ui/api/auth/me", { headers: basicAuthHeader() });
      if (!resp.ok) return null;
      const body = await resp.json();
      if (body?.username) {
        return { username: body.username, role: body.role ?? "user" };
      }
      return null;
    } catch {
      return null;
    } finally {
      fetchPromise = null;
    }
  })();
  return fetchPromise;
}

/** React hook — current auth state, a loading flag, and a re-fetch trigger. */
export function useAuth(): { auth: AuthState | null; loading: boolean; refresh: () => void } {
  const [state, setState] = useState<AuthState | null>(cached ?? null);
  const [loading, setLoading] = useState(cached === undefined);

  const refresh = useCallback(() => {
    cached = undefined;
    setLoading(true);
    fetchMe().then((result) => {
      cached = result;
      setState(result);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (cached !== undefined) {
      setState(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchMe().then((result) => {
      if (!cancelled) {
        cached = result;
        setState(result);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  return { auth: state, loading, refresh };
}
