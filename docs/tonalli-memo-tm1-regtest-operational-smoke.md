# Tonalli Memo Phase 6-H real-regtest operational smoke

## Status

**PHASE 6-H REAL REGTEST SMOKE: PASS**

Phase 6-H establishes real operational evidence for the closed Phase 6-B
through Phase 6-G architecture under eCash regtest. The verified execution
took place on 2026-08-21. This document records the supplied execution
evidence; it does not rerun or reconstruct the smoke.

## Configuration

| Item | Verified value |
| --- | --- |
| RMZWallet base | `c9e5f590bc8eaf037ad2f1534b9c9508af14080e` |
| Bitcoin ABC | `v0.33.10-8dd44759e85b` |
| Network | eCash REGTEST |
| Genesis | `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206` |
| Chronik endpoint | `http://127.0.0.1:18442` |
| Fixture address | `ecregtest:qp63uahgrxged4z5jswyt5dn5v3lzsem6c49crxznd` |
| Fixture locking script | `76a914751e76e8199196d454941c45d1b3a323f1433bd688ac` |

The evidence intentionally excludes the fixture WIF or private key, the RPC
cookie, RPC credentials, wallet secrets, and other private material.

## Initial funding and setup

The fixture was funded through the ordinary local node wallet. The fixture
private key was not imported into that wallet.

| Item | Verified value |
| --- | --- |
| Funding transaction | `e726c369285a29541901aaef382f1300a70f0f20840f1f7a809af8f2e9b75560` |
| Fixture output | `vout 1` |
| Fixture amount | `1000.00 XEC` |
| Setup block height | `102` |

This ordinary regtest transfer supplied the public fixture address without
adding the fixture signing authority to the node wallet.

## Earlier timeout evidence

The first operational publication produced transaction:

```text
85bdf01b09482b93260377dad4af9ce59d45cead1668e73fc2407f07af9769e5
```

The CLI successfully reached all of the following stages:

```text
PREPARED
SIGN approval
SIGNED
BROADCAST approval
SUBMITTED
```

No block was mined within the CLI's 120-second confirmation window. The
observed result was:

```text
CONFIRMATION TIMEOUT
```

This was expected fail-closed behavior and was **not** counted as the Phase
6-H PASS. No automatic rebroadcast occurred. The transaction remained
observable in the regtest mempool, and later chain processing produced a
fixture change output of `997.00 XEC`.

A second pre-final transaction was also part of the operational sequence:

```text
3bae4796eb6a60eb5075acb3afeb908221a5a42df2f5e809266e5397ae7435ed
```

Its `vout 1` produced the later `994.00 XEC` fixture input consumed by the
final successful smoke. This record does not claim that the CLI observed a
positive confirmation for that earlier transaction.

## Final successful smoke

### Prepared candidate and SIGN authorization

| Item | Verified value |
| --- | --- |
| Input | `3bae4796eb6a60eb5075acb3afeb908221a5a42df2f5e809266e5397ae7435ed:1` |
| Input amount | `994.00 XEC` |
| `preparedId` | `prepared:87feddd1cf13712ad47c53db402aeff7` |
| `bindingHash` | `38aba1695127f1f59af7babc3b10a4fa5e4fb2dd58e310a3d7f8526687a037cd` |
| SIGN `operationId` | `tm1-regtest.signing-authorization:f39057cb58f7b29476f3fe2e4d0a615b` |
| Human SIGN phrase | `SIGN 526687a037cd` |

The SIGN phrase was entered by a human after the prepared review was
presented. It authorized signing of that exact prepared candidate; it did not
authorize broadcast.

### Signed artifact and BROADCAST authorization

| Item | Verified value |
| --- | --- |
| `signedId` | `signed:c73d36f57278f6261003881b356f6a25` |
| Transaction ID | `d81ce6db6e6c241f8a77bb431acc6ad9a173d541b7ebb145b719882c7523e642` |
| `signedArtifactHash` | `42e623752c8819b745b1ebb741d573a1d96acc1a43bb778a1f246c6edbe61cd8` |
| BROADCAST `operationId` | `tm1-regtest.broadcast-authorization:2756a79f9073d9315ca5df655e736d1c` |
| Human BROADCAST phrase | `BROADCAST 6c6edbe61cd8` |

The independent BROADCAST phrase was entered by a human after the signed
artifact review was presented. Approval permitted the exact audited artifact
to proceed through the remaining publication-orchestrator checks and Chronik
submission.

### Submission and confirmation

| Item | Verified value |
| --- | --- |
| `submissionId` | `submission:17b629c71bfff4f294d224b0d74ff9b8` |
| Confirmed block | `232073ae241821a92a51987d97a6a9dc7523b1b4bd6142412321e18a3f3e2c10` |
| Block height | `109` |
| Confirmations observed by CLI | `1` |
| CLI exit code | `0` |
| New fixture change | `991.00 XEC` |

The CLI itself observed the positive confirmation and terminated successfully
with exit code `0`.

## Security conclusions

The PASS demonstrated this real operational path:

```text
Chronik UTXO read
  -> PREPARED
  -> independent human SIGN authorization
  -> real runtime signing
  -> signed-artifact audit
  -> independent human BROADCAST authorization
  -> real Chronik submission
  -> exact transaction inclusion in a regtest block
  -> runtime confirmation
  -> CLI exit 0
```

The evidence supports the following conclusions:

- No application-source modification was required for the operational run.
- The closed runtime composition was used; no direct signer path was used.
- The closed Chronik transport was used; no direct broadcast path was used.
- Both SIGN and BROADCAST required separate human actions; no auto-approval
  was used.
- The fixture private key was neither exposed by the smoke nor imported into
  the node wallet.
- No rebroadcast occurred, including after the earlier confirmation timeout.
- Mainnet was not involved.

## Limitations

- This evidence is REGTEST-only.
- It exercises only the deterministic fixture signer.
- Authorization ledger and publication process state remain process-lifetime.
- It does not demonstrate mainnet readiness.
- It does not establish durable restart recovery or durable replay recovery.
- Bitcoin ABC `v0.33.10-8dd44759e85b` is recorded operational evidence, not a
  repo-pinned node dependency.
- Manual block generation was part of the smoke environment.

## Conclusion

**PHASE 6-H REAL REGTEST SMOKE: PASS**

The successful execution provides real-regtest operational evidence for the
existing Phase 6-B through Phase 6-G authority and publication path without
introducing another signing, broadcast, or approval route.
