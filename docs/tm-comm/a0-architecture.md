# TM-COMM A0 architecture

## Purpose

Demonstrate that Tonalli Wallet can host a future private communication system without altering existing financial authority. A0 is architecture and staging readiness, not a complete chat product.

## Closed domain

Authoritative entities:

| Entity | Role |
| --- | --- |
| `Principal` | Server-issued identity after a verified wallet challenge. A known address is not authorization. |
| `ReservationBinding` | Explicit link from an authenticated principal to one fictitious reservation, created only by consuming an operator-issued enrollment token. |
| `Conversation` | One private thread per reservation. Participants are the bound customer and the Xolos Ramírez operator principal. |
| `Message` | Durable private message. Server assigns the authoritative id and timestamp. |
| `MessageReceipt` | Later-compatible delivery/read state per principal. |
| `AuditEvent` | Allow/deny log without message bodies or secrets. |

### Message minimum fields

- `id` — server authoritative
- `clientMessageId` — idempotent per conversation
- `conversationId`
- `senderPrincipalId`
- `senderKind`
- `body`
- `serverCreatedAt` — server authoritative
- `replyToId` — optional
- `status` — `accepted` / `delivered` / `read`

## Authoritative storage

SQLite is the canonical message log (`node:sqlite`, WAL + `synchronous=FULL` on file-backed stores).

`localStorage` is not a source of truth. The staging UI may show a local evidence log, but history is always re-fetched from the server.

Database path, secrets, and enrollment tokens live under `.tmp/tm-comm-staging/` and are independent of production.

## Wallet authentication

Dedicated protocol `TM-COMM-AUTH-V1`. This is **not** the Mining Gateway `/connect/sign-message` flow.

1. Server issues a one-time nonce, expiry, expected audience/origin, and session context.
2. Tonalli signs the exact canonical message with the existing `signMessage` capability.
3. Private keys never leave Tonalli.
4. Server verifies address, compressed public key binding, signature, unused nonce, expiry, audience/origin, and session context.
5. Server creates an HttpOnly `SameSite=Strict` session cookie. The session principal still has **zero** reservation access.

## Binding

A known wallet address grants no expediente.

Xolos Ramírez issues a single-use enrollment token bound to one fictitious reservation and, later, to a previously verified customer email. The authenticated principal consumes the token. Only then does the server create `ReservationBinding` and the reservation conversation.

If the browser sends a `reservationId` that does not match the token, the request fails closed.

## API

All authorization is resolved from the session principal on the server. Browser fields `customerId`, `reservationId`, `conversationId`, `walletAddress`, and `senderPrincipalId` are claims, never proof.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/tm-comm/health` | Staging liveness |
| POST | `/v1/tm-comm/challenges` | Issue challenge |
| POST | `/v1/tm-comm/sessions` | Verify signature, set cookie |
| GET | `/v1/tm-comm/me` | Principal + bindings |
| POST | `/v1/tm-comm/bindings` | Consume enrollment token |
| GET | `/v1/tm-comm/conversations` | List authorized conversations |
| GET | `/v1/tm-comm/conversations/:id` | Get one authorized conversation |
| GET | `/v1/tm-comm/conversations/:id/messages` | List messages |
| POST | `/v1/tm-comm/conversations/:id/messages` | Send message |
| GET | `/v1/tm-comm/messages/:id/receipts` | List receipts |
| PUT | `/v1/tm-comm/messages/:id/receipts` | Upsert own receipt |
| GET | `/v1/tm-comm/attachments/:id` | Always fail closed in A0 |

## Financial frontier

`src/features/privateMessaging`, `server/tmComm` production files, and the future AI registry must not import or invoke:

- signing (`signMsg` / productive wallet signing APIs)
- private keys / seed / mnemonic
- settlement
- broadcast
- `sendXec` / `sendETokens`
- automatic Tonalli Memo publication
- private `agentWalletExecution` capabilities

The staging UI may ask Tonalli to sign a TM-COMM challenge. That is wallet-owned message signing, not a TM-COMM financial capability.

Agent Wallet invariants are unchanged.

## Out of A0

- Complete chat UX
- OpenAI
- Email sending (contract only)
- Tonalli Memo publication (frontier contract only)
- Production data, keys, or funds
