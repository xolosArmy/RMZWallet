# Reproduce TM-COMM staging from scratch

Staging is independent of production: fictitious guests, a dedicated SQLite file, dedicated secrets, and no production keys or expedientes.

## Prerequisites

- Node 24.18+ (repository `engines`)
- Working tree of `feat/tm-comm-a0-architecture-staging`
- No production `.env` secrets are required

## From zero

```bash
cd RMZWallet
rm -rf .tmp/tm-comm-staging
npm run tm-comm:staging
```

In a second terminal:

```bash
VITE_TM_COMM_STAGING=true npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

## URLs

- API health: `http://127.0.0.1:4178/v1/tm-comm/health`
- Staging UI: `http://127.0.0.1:5174/tm-comm-staging`

The Vite dev server proxies `/tm-comm-api` to the API. The browser origin `http://127.0.0.1:5174` is the challenge audience.

## What gets created

All of this is gitignored under `.tmp/`:

| Path | Contents |
| --- | --- |
| `.tmp/tm-comm-staging/tm-comm-a0.sqlite` | Canonical message store |
| `.tmp/tm-comm-staging/bootstrap-receipt.json` | Fictitious enrollment tokens for clients A and B |
| `.tmp/tm-comm-staging/operator-wallet.json` | **PRIVATE KEY MATERIAL / STAGING SECRET**: Contains `secretHex`, `address`, and `publicKeyHex` for the deterministic staging fixture operator |

### Staging Operator Credential Security & Invariants

> [!WARNING]
> **PRIVATE KEY MATERIAL / STAGING SECRET**:
> `.tmp/tm-comm-staging/operator-wallet.json` contains unencrypted private key material (`secretHex`) alongside public metadata (`address`, `publicKeyHex`).
> 
> Security requirements:
> - **File permissions**: Created and enforced with mode `0600` (read/write by owner only).
> - **Directory permissions**: Parent directory `.tmp/tm-comm-staging/` is created and enforced with mode `0700`.
> - **Gitignored**: Entire `.tmp/` directory is gitignored and must NEVER be committed to Git.
> - **Confidentiality**: Do NOT share, and do NOT copy to issue trackers, tickets, chat, public logs, or screenshots.
> - **No production use**: This credential is exclusively for local staging test fixtures. Never use these keys or funds on mainnet or production.
> - **Destruction**: Delete `operator-wallet.json` alongside `.tmp/tm-comm-staging/` whenever destroying or resetting the staging fixture environment.
> 
> **Architecture Invariant**: Staging operator credential persistence is test-fixture infrastructure only and MUST NOT become the production operator key-management model.

Default fictitious reservations:

- Client A: `rsv_staging_client_a` / `client-a.staging@invalid.test`
- Client B: `rsv_staging_client_b` / `client-b.staging@invalid.test`

Emails are placeholders for a later delivery of the enrollment invitation. A0 does not send mail.

## Isolation demo

1. Authenticate wallet A with the TM-COMM challenge (not Mining Gateway connect).
2. Consume A's enrollment token from the bootstrap receipt.
3. Send a private message. Reload the UI. The message returns from SQLite.
4. Authenticate wallet B and consume B's token.
5. Confirm A cannot list, read, write, or fetch attachments/metadata for B.

Automated evidence: `npm run test:tm-comm`.

## Production guards

- `TM_COMM_ENVIRONMENT=production` is refused
- Database paths containing `production` / `prod-data` / `mainnet-secrets` are refused
- `VITE_TM_COMM_STAGING` defaults to `false`, so the UI route is absent in production builds
- Agent Wallet execution, settlement, broadcast, and Memo publication are not started by this process
