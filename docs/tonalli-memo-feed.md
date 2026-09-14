# Tonalli Memo feed

Tonalli Wallet reads the public Tonalli Memo HTTP API directly from the browser. After its existing TM1 publisher broadcasts a transaction, it submits only the resulting TXID for server-side indexing and waits for the server's verification result.

## API architecture

The integration lives in `src/integrations/tonalliMemo/` and uses native `fetch` with `credentials: "omit"`. JSON responses are treated as `unknown` and validated by handwritten runtime guards before the UI receives typed data.

Only these public endpoints are consumed:

- `GET /api/v1/health`
- `GET /api/v1/feed?limit=25`
- `GET /api/v1/tx/:txid`
- `POST /api/v1/index-requests`

The POST body is exactly `{ "txid": "<64 lowercase hex characters>" }`. The wallet does not send memo content, identity, status, metadata, cookies, credentials, or an administrative token. Responses use `queued`, `already_queued`, or `already_indexed`; all trust remains on the server.

The feed is expected to contain only `VERIFIED` official Tonalli Memo records. The transaction endpoint may return `VERIFIED`, `UNAUTHORIZED`, `NO_MEMO`, `INVALID_MEMO`, `MULTIPLE_MEMOS`, or `verification: null`.

## Environment configuration

The browser-facing public variable is:

```text
VITE_TONALLI_MEMO_API_BASE_URL
```

If it is blank or unset, Tonalli Wallet defaults to:

```text
/tonalli-memo-api/v1
```

The value may be relative or absolute, for example:

```text
https://memo-api.example/api/v1
```

No `VITE_` variable may contain a secret.

## Vite development proxy

Local development proxies:

```text
/tonalli-memo-api/* -> http://127.0.0.1:3000/api/*
```

The localhost target is only present in Vite development server configuration and must not appear in the production bundle.

## Production CORS

A cross-origin Tonalli Memo API deployment must configure `CORS_ORIGINS` with the exact Tonalli Wallet production origin. Wildcard origins are not appropriate for production wallet surfaces.

## Trust semantics

Tonalli Wallet displays Tonalli Memo registry-policy verification over normalized Chronik transaction data. It does not independently verify eCash consensus or transaction signatures.

The publisher distinguishes these outcomes:

- `broadcasting`: the wallet is signing or transmitting and no on-chain success is claimed yet;
- `indexing_pending`: broadcast succeeded and the TXID is being checked;
- `success`: the transaction endpoint returned `VERIFIED`;
- `policy_rejected`: the transaction exists but returned a durable non-`VERIFIED` policy status;
- `indexing_delayed`: verification did not complete within 60 seconds or the API was temporarily unavailable.

An indexing retry resubmits and polls the same TXID. It never signs or broadcasts another transaction.

## Error behavior

The client distinguishes network failures, HTTP failures, malformed JSON, and invalid DTOs. It preserves HTTP status for non-JSON, empty, malformed, and non-2xx responses, but it never exposes raw server response bodies in the UI.
