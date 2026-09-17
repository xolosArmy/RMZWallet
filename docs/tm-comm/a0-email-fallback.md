# Email fallback contract (A0)

Implementation is M1. A0 only defines the contract so M1 cannot invent a second source of truth.

## Trigger

Fallback email is considered only when one of these is true:

- `no-live-session` — the recipient has no active TM-COMM session
- `unread-after-ttl` — an accepted message remains unread past the operational TTL
- `operator-initiated-notice` — Xolos Ramírez explicitly requests a notice

The canonical message already exists in SQLite before any email is considered.

## What email may contain

Allowed:

- A notice that a private message exists
- An opaque conversation reference
- A Tonalli link to open the authorized conversation
- An enrollment reminder to the **previously verified** customer email

Forbidden:

- Full message body
- Another customer's data
- Session cookies/tokens
- Wallet private material
- A live enrollment token after it has been consumed

## Dedup

Table `tm_comm_email_dispatches` has a unique key `(message_id, principal_id, channel)`.

Channel is always `email-fallback`. States: `pending`, `sent`, `failed`, `suppressed`.

A second trigger for the same message and recipient must reuse that row. It must not insert a second send. M1 will treat uniqueness as the anti-duplication invariant.

`TM_COMM_EMAIL_FALLBACK_IMPLEMENTED` remains `false` in A0.
