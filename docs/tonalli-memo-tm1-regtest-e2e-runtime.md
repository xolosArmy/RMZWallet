# TM1 Phase 6-G interactive regtest E2E runtime

## Status and boundary

This executable is **REGTEST ONLY**. It is an explicit human-operated acceptance tool for the closed TM1 regtest runtime. It is not a browser UI, production wallet integration, mainnet path, or automated CI smoke.

Run it only with a local eCash regtest node, local Chronik, and the public deterministic fixture funds:

```bash
TM1_REGTEST_CHRONIK_URL=http://127.0.0.1:3000 npm run test:tm1-regtest-e2e
```

An interactive TTY is mandatory. Non-TTY stdin, EOF, a blank answer, `yes`, an incorrect stage, or an incorrect fingerprint fails closed. There is no approval flag, environment-variable approval, or automatic approval mode.

## Closed-runtime lifecycle

The executable constructs `createTm1RegtestRuntime()` and uses only its public facade:

1. `prepare()` builds the exact prepared review.
2. The SIGN provider displays that review and requests independent human consent.
3. `authorizeAndSign()` revalidates and signs inside the closed runtime.
4. The BROADCAST provider displays the exact signed-artifact identity and requests a second consent.
5. `approveAndBroadcast()` re-audits and may dispatch inside the closed runtime.
6. The CLI uses bounded `confirm()` or `reconcile()` observation without retransmission.

The CLI does not own a signer, key, UTXO reader, candidate builder, audit implementation, Chronik client, or transport. Runtime authorization state, locks, and consumed grants are process-lifetime only and are not durable across process restart.

## SIGN consent

The SIGN review displays the operation ID, prepared ID, full binding hash, content hash, expiry, exact regtest identity, memo/effective content, ordered inputs, ordered outputs, and fee.

The human must enter exactly:

```text
SIGN <last-12-lowercase-hex-of-bindingHash>
```

The prompt states that this authorizes signing the exact prepared candidate and does not authorize broadcast.

## BROADCAST consent

Only after a signed review exists, the BROADCAST review displays the operation ID, signed ID, txid, signed-artifact hash, binding/content hashes, expiry, ordered outputs, and fee. Raw signed transaction bytes are not displayed.

The human must enter exactly:

```text
BROADCAST <last-12-lowercase-hex-of-signedArtifactHash>
```

The prompt states that approval authorizes possible broadcast of that exact signed artifact. The adapter does not itself transmit it; the publication orchestrator re-audits it and performs final checks before dispatch. Approval does not claim that broadcast already occurred or is guaranteed.

Both authorization TTLs are five minutes and begin independently. The 12-character fingerprints are anti-confusion labels, not cryptographic authentication. Cryptographic authority remains bound by the closed runtime to `preparedId + bindingHash` and independently to `signedId + txid + signedArtifactHash`.

The fixed requester origins and display names are stable review labels for this CLI. They are not authenticated identities.

## Confirmation and uncertainty

Confirmation is observation-only, polling every 1 second for at most 120 seconds. Exit code `0` requires a positive block confirmation. Mempool presence is not success, so a regtest operator may need to mine a block. An accepted transaction that stays unmined reaches the deadline and exits `22`.

If dispatch returns an ambiguous result, the runtime enters `broadcastUncertain`. The CLI prints the safe transaction identity, warns that broadcast may have succeeded, and calls only `reconcile()`. It never calls `approveAndBroadcast()` again. Unresolved uncertainty exits `21`.

## SIGINT

One process-level `AbortController` covers prepare, both authorization stages, and observation. Before dispatch, Ctrl-C aborts without granting later authority and exits `130`.

Once public runtime state reaches `broadcasting`, transport may be irreversible. Ctrl-C records the abort request but does not terminate the transport promise or claim cancellation. The CLI waits for submitted/uncertain state, reports it without retransmission, and then exits `130`.

## Exit codes

- `0`: positively confirmed or reconciled.
- `1`: unexpected safely redacted failure.
- `2`: invalid arguments/configuration or non-TTY stdin.
- `10` / `11`: SIGN rejected / expired.
- `12` / `13`: BROADCAST rejected / expired.
- `20`: preparation, signing, provider, or pre-dispatch failure.
- `21`: unresolved broadcast uncertainty.
- `22`: unresolved submitted confirmation.
- `130`: SIGINT or external abort.

The runtime's strict loopback endpoint and exact regtest-genesis attestation prevent this executable from becoming a mainnet path. Never use real funds.
