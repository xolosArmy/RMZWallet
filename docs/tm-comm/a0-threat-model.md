# TM-COMM A0 threat model

Scope: staging-only private messaging hosted by Tonalli. No production data.

## Assets

- Private message bodies
- Reservation bindings
- Session cookies
- Enrollment tokens
- Wallet private keys (must remain in Tonalli)

## Actors

- Fictitious customer A
- Fictitious customer B
- Staging operator (Xolos Ramírez)
- Browser attacker who can edit URLs and JSON bodies
- Future AI agent

## Controls in A0

| Risk | Control |
| --- | --- |
| Cross-tenant read/write | Server ACL from session principal + conversation participants. Client ids are claims. |
| Address replay as authority | Address authentication ≠ binding. Enrollment token required. |
| Challenge reuse | One-time nonce, hashed at rest, consumed atomically. |
| Cross-origin session mint | Audience/origin and session context checked server-side. |
| Key exfiltration | Challenge signing uses existing Tonalli `signMessage`. Keys never enter TM-COMM. |
| Financial confusion | Architecture tests fail if TM-COMM imports signing/settlement/broadcast/send/Memo/Agent Wallet internals. |
| Attachment leakage | Attachment routes fail closed. |
| Log leakage | Audit events store reason codes, not bodies or tokens. |
| Email duplication (future) | Unique dispatch key; implementation deferred to M1. |
| Agent overreach | Send disabled; privileged tools disabled; no wallet capability from agent auth. |
| Accidental production | Staging-only config, production path/env refused, UI flag default false. |

## Residual risks

- Staging enrollment tokens in `.tmp/` are secrets for that machine; anyone with the file can bind a staging wallet to a fictitious reservation.
- HttpOnly cookies on HTTP localhost omit `Secure`. HTTPS production (later) must set `Secure`.
- Challenge messages are user-visible plaintext. They must never include reservation contents.
- A0 has no rate limit; staging can be brute-forced locally.
- Signature verification depends on `ecash-lib` `verifyMsg`. A compromised frontend cannot mint a session without a valid wallet signature, but XSS on the staging origin could use an already-open Tonalli to sign a fresh challenge. Treat the staging origin as trusted.
- Operator principal is a staging fixture, not a hardware-backed operator identity.
- Email and AI are unimplemented; residual risk is that a later milestone enables send/email without re-running isolation tests.

## Explicit non-goals

No merge, no production, no real clients, no OpenAI, no real funds, no automatic Memo publication.
