# H3WC B1A transport candidate

This candidate is dormant unless `VITE_X402_H3WC_ENABLED=true` is supplied at
build/runtime configuration time. It uses only the dedicated
`VITE_X402_H3WC_PROJECT_ID`; the legacy WalletConnect project variables are
never consulted. Production requester identity is pinned to
`https://x402.ecash.mx`; a non-production requester origin must be supplied
explicitly.

The modern WalletKit dependency is isolated behind npm aliases:

- `@xolosarmy/h3wc-walletkit` → `@reown/walletkit@1.5.6`
- `@xolosarmy/h3wc-core` → `@walletconnect/core@2.23.10`

The legacy direct `@walletconnect/core` remains pinned to `2.23.4` and
`@walletconnect/web3wallet` retains its existing `2.17.1` nested spine. This
prevents npm deduplication from changing the legacy runtime.

The H3WC adapter creates Core with the fixed purpose prefix
`tonalli-h3wc-v1`, owns only the `ecash:1` identity/authorization namespace,
and qualifies the effective approved/restored session exactly. A proposal is
not authority: the final namespace must contain exactly
`ecash_getAccountIdentity`, `ecash_signMessage`, no events, and one canonical
CAIP-10 account.

The global Web Lock `tonalli:wc:owner:v1` is the only authority gate. A
per-request lock is nested under that owner callback. Broadcast coordination
is advisory, and the journal is a separate `tonalli-h3wc-journal-v1` IndexedDB
database containing only non-secret coordination fields.

This is a pre-crypto candidate. `ecash_getAccountIdentity` is read-only and
requires an injected, already-active public identity. `ecash_signMessage`
always returns the stable error `H3WC_SIGNING_NOT_ENABLED` with code `-32098`;
no signing primitive is imported or called. H3C legacy tab transport remains
unchanged while the flag is off. Live relay, browser, restore, and cross-tab
qualification remain pending human B1-QA.
