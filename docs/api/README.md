# FlowKy API reference

Base URL: `https://flowky.ai/api`

Everything here is stable unless marked otherwise. Breaking changes get a new path segment, never a silent change to an existing one.

---

## Authentication

Two credentials exist and they are not interchangeable.

| Credential | Used by | Lifetime | Where it lives |
|---|---|---|---|
| Session cookie | The web app | 30 days | `__session`, http-only |
| Extension JWT | The VS Code extension | 30 days | Editor secret storage |

The extension token is issued after you sign in on the website and click **Connect**. It is an HS256 JWT with `iss: flowky-web` and `aud: flowky-extension`.

```http
Authorization: Bearer <jwt>
```

> **Rotation invalidates everything.** The signing secret is shared with the web session layer, so rotating it logs out every browser session *and* invalidates every extension token in the field. Plan it as a release, not a maintenance task.

---

## `GET /v1/subscription/:userId`

Returns the caller's plan and usage. `:userId` must match the `sub` claim of the token — requesting another user returns `403`, never another user's data.

**Response `200`**

```json
{
  "userId": "9c1f…",
  "email": "you@example.com",
  "planTier": "pro",
  "validUntil": "2026-09-01T00:00:00.000Z",
  "trialEndsAt": null,
  "requestsUsedToday": 42,
  "maxRequestsPerDay": 300
}
```

| Field | Notes |
|---|---|
| `planTier` | `free`, `pro` or `enterprise`. Treat anything else as `free` rather than throwing. |
| `validUntil` | `null` on the free plan. |
| `requestsUsedToday` | Resets at 00:00 UTC. |
| `maxRequestsPerDay` | 30 / 300 / 2000 by tier. |

**Errors**

| Status | Meaning | What a client should do |
|---|---|---|
| `401` | Token missing, malformed or expired | Prompt the user to reconnect. Do **not** silently fall back to the free tier — a paying user who is quietly downgraded has no way to understand what happened. |
| `403` | Token valid, wrong user | Treat as a bug in your client, not a plan change. |
| `429` | Rate limited | Honour `Retry-After`. |
| `502` | Upstream unavailable | Use your cached plan, and say it is cached. |

---

## `POST /v1/usage`

Records consumption against the daily limit.

```json
{ "feature": "ai_request", "quantity": 1 }
```

**Response `200`**

```json
{ "usedToday": 43, "remaining": 257, "dailyLimit": 300 }
```

Returns `429` with `Retry-After` when the limit is reached.

> **Units.** `dailyLimit` counts *requests*, not tokens. If you cache this value alongside a token budget from elsewhere, keep them in separate fields — conflating the two produces a limit check that can never fire.

---

## `POST /auth/extension-token`

Called by the website, not by clients. Requires a live non-guest session and returns a deep link rather than the raw token, so the token never touches page JavaScript.

```json
{ "url": "vscode://FlowKy.flowky/authenticate?token=<jwt>" }
```

> The URI includes the publisher prefix (`FlowKy.flowky`). A publisher-less `vscode://flowky/...` will not reach the extension.

---

## Rate limits

| Endpoint group | Limit |
|---|---|
| Auth | 10 requests / 5 min / IP |
| API | 100 requests / min / user |

Limits are per user when a session is present, per IP otherwise.

---

## Client guidance

**Distinguish rejection from unavailability.** `401` means the credential is dead; `502` means we are. Collapsing both into "failed" produces the silent-downgrade bug described above, which is invisible to you and infuriating to the user.

**Time out every call.** None of these endpoints is on a user's critical path. Five seconds is generous.

```ts
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${jwt}` },
  signal: AbortSignal.timeout(5000)
});
```

**Validate the endpoint before attaching the token.** If your client reads the API base URL from user-editable configuration, check it against an allow-list first. Otherwise a hostile config sends the user's credential to whoever wrote it.

**Never log the response verbatim on error.** Upstream messages can echo the token back.
