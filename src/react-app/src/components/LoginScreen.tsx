import { useState } from "react";
import { storeCredentials } from "../lib/auth";

type Role = "admin" | "user";

const ROLES: { id: Role; icon: string; label: string; desc: string }[] = [
  {
    id: "admin",
    icon: "🔧",
    label: "Admin",
    desc: "Full catalog access, scheduling, model switching, and curation tools.",
  },
  {
    id: "user",
    icon: "👤",
    label: "User",
    desc: "Browse the catalog, run prompts, and save artifacts to your space.",
  },
];

/**
 * Two-step login screen: pick a role, then enter credentials.
 * On success the credentials are stored in sessionStorage (dva_user/dva_pass)
 * — every downstream transport already reads them:
 *   - HTTP API calls attach `Authorization: Basic …` (useAgent/CatalogTree/agent-bridge)
 *   - the agent WebSocket passes them as ?user=&pass= (agent-bridge)
 *   - the host validates both against BASIC_AUTH_USERS (host.ts)
 */
export function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [role, setRole] = useState<Role | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const pickRole = (r: Role) => {
    setRole(r);
    setUsername(r);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/ui/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError(body?.error ?? "Login failed.");
        return;
      }
      storeCredentials(username.trim(), password);
      onLogin();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">DVA</div>
        <div className="login-subtitle">Data Visualization Agent</div>

        {role === null ? (
          <>
            <div className="login-prompt">Who is logging in?</div>
            <div className="login-role-grid">
              {ROLES.map((r) => (
                <button key={r.id} type="button" className="login-role-btn" onClick={() => pickRole(r.id)}>
                  <span className="login-role-icon">{r.icon}</span>
                  <strong>{r.label}</strong>
                  <span className="login-role-desc">{r.desc}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <form className="login-credentials" onSubmit={submit}>
            <button type="button" className="login-back-btn" onClick={() => { setRole(null); setError(null); }}>
              ← Back
            </button>
            <div className="login-role-badge">
              Logging in as <strong>{role}</strong>
            </div>
            {error && <div className="login-error">{error}</div>}
            <label className="login-field">
              <span>Username</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                disabled={submitting}
                autoFocus
              />
            </label>
            <label className="login-field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
              />
            </label>
            <button type="submit" className="login-submit-btn" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
