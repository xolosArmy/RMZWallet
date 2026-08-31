# TM1 remote rollback-witness HTTP protocol v1

Gate B slice 1 client protocol. This is not a Chronik, Memo feed, or
publication API. The remote service is an independently persisted
authenticated append-only witness. The authority gate still parses and
authenticates every returned snapshot.

## Endpoint

`POST {endpointUrl}/v1/{operation}`

`endpointUrl` is an `https:` origin (or loopback `http:` for tests only),
with no userinfo, query, or fragment. Optional pathname is a base prefix.

Operations: `read` | `enroll` | `reserve` | `finalize` | `verifyRecord`

## Request envelope

```json
{
  "protocol": "tonalli.tm1-rollback-witness-http",
  "protocolVersion": 1,
  "operation": "read",
  "payload": {}
}
```

`payload` is the corresponding `Tm1RollbackWitness*` input (no `signal`) or,
for `verifyRecord`, the witness record.

## Success envelope

```json
{
  "protocol": "tonalli.tm1-rollback-witness-http",
  "protocolVersion": 1,
  "ok": true,
  "result": null
}
```

`result` remains `unknown` to the client:

- `read`: snapshot or `null` (never enrolled; not permission to enroll)
- `enroll` / `reserve` / `finalize`: snapshot
- `verifyRecord`: `true` only when the remote authenticates the exact record

## Error envelope

```json
{
  "protocol": "tonalli.tm1-rollback-witness-http",
  "protocolVersion": 1,
  "ok": false,
  "error": "WITNESS_CONFLICT"
}
```

Allowed `error` codes: `INVALID_WITNESS_INPUT`, `INVALID_WITNESS_RECORD`,
`WITNESS_ALREADY_ENROLLED`, `WITNESS_CONFLICT`, `WITNESS_NOT_ENROLLED`,
`WITNESS_UNAVAILABLE`, `WITNESS_UNVERIFIABLE`.

## Client fail-closed mapping

- missing/invalid adapter config → `WITNESS_NOT_CONFIGURED`
- abort, timeout, network, HTTP without a known error envelope, truncated
  or non-JSON body → `WITNESS_UNAVAILABLE`
- well-formed JSON that is not a parseable snapshot is returned as
  `unknown`; the authority gate maps parse failure to `WITNESS_UNVERIFIABLE`
- `verifyRecord` is `true` only on JSON `true`; otherwise `false` or a
  thrown unavailability/unverifiable error
- no in-memory fallback
- no invented snapshot
