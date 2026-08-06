# TM1 Draft 0.2 regtest E2E harness

## Status

This harness is an isolated Node.js acceptance tool for Phase 6-A. It is not mounted in React, is not part of the browser bundle, and does not enable production or mainnet publication.

Run it with:

```bash
TM1_REGTEST_CHRONIK_URL=http://127.0.0.1:3000 npm run test:tm1-regtest-e2e
```

The endpoint is supplied through a Node-only environment variable. The harness deliberately does not use a `VITE_` variable.

## Flow

When a real local eCash regtest node with Chronik is available, the harness:

1. constructs the strict local Chronik transport;
2. attests the exact eCash regtest genesis;
3. queries token-free UTXOs for the deterministic fixture P2PKH identity;
4. plans an ordinary TM1 Draft 0.2 post;
5. creates and revalidates the canonical candidate;
6. signs with the isolated regtest fixture P2PKH signer;
7. independently audits the signed artifact through the in-memory delivery boundary;
8. broadcasts the exact audited bytes through the strict Chronik transport;
9. queries Chronik for the same transaction id;
10. reports mempool or confirmed status.

The harness does not invent or inject nonexistent prevouts. If the fixture address has no spendable XEC-only UTXO, it fails with `FIXTURE_UTXO_REQUIRED` and prints the regtest-only fixture address.

## Validated behavior

Locally validated on branch head `778328cc913250d11ad077921700ff1c1247bae1`:

- the harness is included in TypeScript checking through `tsconfig.tm1-regtest-e2e.json`;
- `npm run typecheck` passed;
- `npm run lint` passed;
- a missing Chronik endpoint returned non-zero and was classified as `CHRONIK_UNAVAILABLE`;
- no production endpoint or fallback was used;
- the previous complete suite on the branch lineage passed 324 Vitest tests plus 4 Node tests, 328 total.

## Pending positive acceptance

Phase 6-A is not positively complete until a real local environment demonstrates:

- eCash/Bitcoin ABC running in regtest;
- Chronik serving that exact regtest genesis;
- at least one spendable token-free fixture UTXO;
- candidate creation and fresh-state revalidation;
- real P2PKH fixture signing;
- Chronik broadcast acceptance;
- exact transaction-id equality;
- successful Chronik lookup of the submitted transaction.

The preferred final evidence is the harness output `TM1 REGTEST E2E: ÉXITO` together with the observed transaction id.

## Security boundary

This harness:

- accepts only the loopback endpoint policy enforced by `Tm1ChronikRegtestDeliveryTransport`;
- uses the public deterministic regtest fixture key only;
- does not read the active wallet, mnemonic, production key material, or product Chronik configuration;
- does not import React, routes, registries, `XolosWalletService`, or the production `getChronik` singleton;
- has no mainnet fallback;
- must not be interpreted as proof of production readiness.
