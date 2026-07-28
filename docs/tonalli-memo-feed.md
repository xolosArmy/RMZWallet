# Tonalli Memo feed

Tonalli Wallet reads the public Tonalli Memo HTTP API directly from the browser. Hito 9A is read-only: it does not publish memos, construct transactions, sign, broadcast, change wallet identity, introduce TM1, or require backend protocol changes.

## API architecture

The integration lives in `src/integrations/tonalliMemo/` and uses native `fetch` with `credentials: "omit"`. JSON responses are treated as `unknown` and validated by handwritten runtime guards before the UI receives typed data.

Only these public endpoints are consumed:

- `GET /api/v1/health`
- `GET /api/v1/feed?limit=25`
- `GET /api/v1/tx/:txid`

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

## Error behavior

The client distinguishes network failures, HTTP failures, malformed JSON, and invalid DTOs. It preserves HTTP status for non-JSON, empty, malformed, and non-2xx responses, but it never exposes raw server response bodies in the UI.

## Limitations

The feed is official and read-only in this milestone. Publication remains a separate future milestone.
