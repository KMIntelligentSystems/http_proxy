 Security Model Analysis — Remote-Agent Bridge

 ### Current State

 Looking at proxy.ts, host.ts, and remote-agent.ts, the current model is:

 ┌──────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────┐ 
 │ Layer                │ Mechanism                                                                                                                  │ Gap                                                                                         │ 
 ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ Proxy (:8080)        │ AUTH_TOKEN Bearer check — only on non-loopback BIND                                                                        │ On 127.0.0.1, auth is a no-op (return true). Deployed on a real interface, it works.        │ 
 ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ Host (:3100)         │ x-loopback: 1 header gate — prevents clients from hitting host directly                                                    │ No per-client isolation. All tabs share the same agent session.                             │ 
 ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ Bridge               │ WebSocket to /ui/ws/agent + POST /ui/api/agent/prompt — no auth headers sent by the browser at all                         │ Zero auth at the browser layer. The proxy is the only gate.                                 │ 
 │ (browser→host)       │                                                                                                                            │                                                                                             │ 
 ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ WebSocket auth       │ The browser WebSocket API doesn't support custom headers, so the auth check on upgrade only sees what the proxy forwarded. │ Any loopback client can open /ui/ws/agent and receive all agent events, even artifacts from │ 
 │                      │ Currently nothing.                                                                                                         │ other sessions.                                                                             │ 
 ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ Artifact access      │ GET /ui/api/artifacts/:id — no session check; any artifact ID is readable                                                  │ If someone guesses an artifact ID, they get it.                                             │ 
 └──────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────┘ 

 ### Three Failure Modes Worth Addressing

 1. Cross-tab state bleed. Two loopback browser tabs both listen to the same agent WebSocket. Tab A's prompt results stream to Tab B. This is a UX bug today but becomes a data leak if this ever runs multi-user.
 2. CSRF on prompt submission. POST /ui/api/agent/prompt has no origin check, no CSRF token, no custom header requirement. A malicious page on another tab could submit prompts.
 3. Artifact enumeration. /ui/api/artifacts?all=1 returns all artifacts across sessions. No access control at all.

 ────────────────────────────────────────────────────────────────────────────────

 ### Recommended Model: Auto-generated per-launch session key

 The best fit for this architecture is a stateless, header-based session key generated at host startup and injected into the web UI. Here's why it wins over the alternatives:

 ┌─────────────────────────┬───────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
 │ Approach                │ Pros                                  │ Cons for this use case                                                                │
 ├─────────────────────────┼───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
 │ Cookie + CSRF token     │ Standard, secure                      │ Cookies don't work with WebSocket in all browsers; adds session management complexity │
 ├─────────────────────────┼───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
 │ OAuth/OIDC              │ Industry standard                     │ Grossly over-engineered for a single-user dev tool                                    │
 ├─────────────────────────┼───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
 │ mTLS / client certs     │ Strongest                             │ Requires cert management; browser UX is terrible                                      │
 ├─────────────────────────┼───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
 │ Startup token in header │ Stateless, WS-compatible, CSRF-immune │ Token lives in browser memory (acceptable for dev tool)                               │
 └─────────────────────────┴───────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘

 #### How It Works

 ```
   ┌─ Startup ────────────────────────────────────────────────────┐
   │  host.ts generates: SESSION_KEY = crypto.randomUUID()        │
   │  Injects into the web UI HTML: window.__SESSION_KEY = "..."  │
   └──────────────────────────────────────────────────────────────┘

   ┌─ Browser requests ───────────────────────────────────────────┐
   │  fetch("/ui/api/agent/prompt", {                             │
   │    headers: { "X-Session-Key": window.__SESSION_KEY }        │
   │  })                                                          │
   │                                                              │                                                                                                                                                                                  
   │  new WebSocket("ws://host/ui/ws/agent?key=" + SESSION_KEY)   │
   └──────────────────────────────────────────────────────────────┘

   ┌─ Proxy check (always, even loopback) ────────────────────────┐
   │  For HTTP: verify X-Session-Key header matches               │
   │  For WS upgrade: verify key query param matches              │                                                                                                                                                                                  
   │  If mismatch → 401                                           │                                                                                                                                                                                  
   └──────────────────────────────────────────────────────────────┘                                                                                                                                                                                   ```

 #### Why This Is the Right Fit

 1. WebSocket-compatible. Browsers can't set custom headers on WebSocket constructors, but they can pass query parameters. The proxy already inspects the upgrade request — it can parse the query string.
 2. CSRF-immune by design. The key lives in a JavaScript variable and is sent as a custom header (X-Session-Key) or query parameter. A cross-origin page cannot set custom headers on fetch() (CORS preflight blocks it), and cannot open a
 WebSocket with the right query param.
 3. No persistence, no cookies, no state. The key is ephemeral — regenerated on every host restart. Perfect for a local dev harness.
 4. Minimal code delta. The proxy already has an auth check path. The host already injects HTML at /ui. The changes are surgical:
     - host.ts: Generate key at startup, inject window.__SESSION_KEY into the served HTML
     - proxy.ts: Extract and verify key from headers (HTTP) and query params (WS upgrade)
     - remote-agent.ts: Read window.__SESSION_KEY and attach it to fetch + WebSocket
 5. Works on loopback too. The current "loopback = no auth" shortcut goes away. All traffic — even from 127.0.0.1 — carries the key. This closes the cross-tab bleed issue.

 #### What About the Existing AUTH_TOKEN?

 Keep it. It becomes the deployment gate — required only when BIND is non-loopback. The session key is the local gate. Two layers, two different threat models:

 ┌────────────────────────────┬─────────────────┬───────────────────────────────────────────────────────────────────────────────────────────┐
 │ Layer                      │ Scope           │ Purpose                                                                                   │
 ├────────────────────────────┼─────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
 │ AUTH_TOKEN (proxy)         │ External access │ Prevents unauthorized remote clients from reaching the proxy at all                       │
 ├────────────────────────────┼─────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
 │ X-Session-Key (proxy→host) │ Internal access │ Prevents loopback clients (and cross-tab) from hijacking the agent session; prevents CSRF │
 └────────────────────────────┴─────────────────┴───────────────────────────────────────────────────────────────────────────────────────────┘

 #### Additional Hardening (Low Effort, High Value)

 - Artifact access control: GET /ui/api/artifacts/:id should require X-Session-Key header. Same for the ?all=1 listing.
 - Rate limiting the prompt endpoint: A simple in-memory debounce (already partially present with promptInFlight) — extend to reject rapid-fire submissions.
 - Content-Type check on POST: Verify Content-Type: application/json before parsing the body (prevents simple form-based CSRF even without the header).
 - BLS proxy hardening: Require the session key on /ui/api/bls — right now any loopback client can burn through your BLS API quota.

 ────────────────────────────────────────────────────────────────────────────────

 ### Concrete Plan

 If you go with this, the implementation touches exactly these files:

 ┌───────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ File                                  │ Change                                                                                                                                    │
 ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ src/host.ts                           │ Generate SESSION_KEY at startup; inject window.__SESSION_KEY into the /ui HTML response; require key on all /ui/api/* endpoints           │
 ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ src/proxy.ts                          │ Extract and verify X-Session-Key header on HTTP; extract and verify ?key= query param on WS upgrade; reject with 401 if absent/mismatched │
 ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ src/react-app/src/lib/remote-agent.ts │ Read window.__SESSION_KEY; attach to fetch() calls as X-Session-Key header; append ?key= to WebSocket URL                                 │
 └───────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

 The changes are fully backward-compatible: on startup, if no session key is set, the proxy falls back to the existing behavior (loopback = open, non-loopback = AUTH_TOKEN). The React app degrades gracefully if window.__SESSION_KEY is
 undefined.

 Want me to start implementing this, or would you like to discuss any part of the model?