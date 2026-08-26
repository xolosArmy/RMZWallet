# Gate H3B — Tonalli authorization proof

Gate H3B is an isolated, feature-flagged wallet-side authorization dry run. Tonalli validates a short-lived request that contains the exact reviewed Gate H2A requirement and a Gate H3A approval marker. It then asks the wallet user for a second explicit decision before using Tonalli's existing message-signing boundary.

The result is an authorization-only proof. It is not an x402 payment signature, transaction signature, payment, settlement, broadcast, or protected-resource unlock. The H2A destination is a deterministic fixture and must not receive funds.

## Request transport and schema

The only accepted route form is:

```text
/connect/x402-authorize#request=<canonical-unpadded-base64url-json>
```

Query-string requests, extra or duplicate fragment parameters, arbitrary origins, and arbitrary callback URLs are rejected. The decoded contract is closed and must contain exactly:

```json
{
  "type": "x402ecash-h3b-request",
  "version": 1,
  "targetGate": "H3B",
  "sourceOrigin": "https://x402.ecash.mx",
  "returnUrl": "https://x402.ecash.mx/experiments/webmcp/",
  "challengeId": "<22-64 character canonical base64url challenge, at least 128 bits>",
  "issuedAt": 0,
  "expiresAt": 0,
  "paymentRequired": {
    "x402Version": 2,
    "error": "PAYMENT-SIGNATURE header is required",
    "resource": {
      "url": "https://api.x402.ecash.mx/v1/resource/demo",
      "description": "x402eCash WebMCP Challenge demo resource",
      "mimeType": "application/json",
      "serviceName": "x402eCash"
    },
    "accepts": [
      {
        "scheme": "xec-prepaid-utxo",
        "network": "xec:mainnet",
        "amount": "10000",
        "asset": "XEC",
        "payTo": "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w",
        "maxTimeoutSeconds": 60,
        "extra": {
          "displayAmount": "100 XEC",
          "experimental": true,
          "gate": "H2A"
        }
      }
    ],
    "extensions": {}
  },
  "approval": {
    "status": "payment_approved",
    "gate": "H3A",
    "approved": true,
    "performed": false
  }
}
```

`issuedAt` and `expiresAt` are safe-integer Unix seconds. The request lifetime cannot exceed 300 seconds, expired requests fail closed, and excessive clock skew is rejected. The fragment is removed with `history.replaceState` only after both request validation and active-wallet resolution succeed. No request or result is persisted.

## Reviewed payment requirement

H3B accepts exactly the H2A experimental requirement: x402 transport version 2, resource `https://api.x402.ecash.mx/v1/resource/demo`, one provisional `xec-prepaid-utxo` acceptance on `xec:mainnet`, asset `XEC`, amount `10000`, display amount `100 XEC`, the deterministic fixture destination, timeout 60, `experimental: true`, Gate H2A, and empty extensions.

The proof binds the complete requirement as:

```text
paymentRequiredSha256 = SHA-256(UTF8(canonicalize(paymentRequired)))
```

Canonical JSON recursively sorts object keys and preserves array order. The reviewed deterministic fixture hash is:

```text
d865139386538ad3fddaa400d95c4074333cd52fdbbf8c1c6d42984fe214d793
```

## Signed authorization proof

After the second wallet confirmation, Tonalli constructs this unsigned proof internally:

```json
{
  "type": "tonalli-x402-authorization-proof",
  "version": 1,
  "gate": "H3B",
  "mode": "authorization-dry-run",
  "challengeId": "<request challenge>",
  "sourceOrigin": "https://x402.ecash.mx",
  "resourceUrl": "https://api.x402.ecash.mx/v1/resource/demo",
  "paymentRequiredSha256": "<lowercase SHA-256 hex>",
  "x402Version": 2,
  "scheme": "xec-prepaid-utxo",
  "network": "xec:mainnet",
  "asset": "XEC",
  "amount": "10000",
  "displayAmount": "100 XEC",
  "payTo": "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w",
  "payer": "<active Tonalli eCash address>",
  "publicKey": "<active compressed public key>",
  "issuedAt": 0,
  "expiresAt": 0,
  "paymentPerformed": false,
  "transactionCreated": false,
  "broadcasted": false
}
```

The only signable message is built by Tonalli:

```text
TONALLI_X402_H3B_AUTHORIZATION_PROOF_V1
<canonical JSON of the unsigned proof>
```

The final canonical proof adds only:

```json
{
  "authorizationMessage": "<the exact message above>",
  "authorizationSignature": {
    "type": "tonalli-message-signature",
    "publicKey": "<same active compressed public key>",
    "signature": "<opaque Tonalli message signature>"
  }
}
```

The three false boundary flags are inside the signed message. Tonalli rechecks the active address, public key, and expiration immediately before one signing call. Rejection, double activation, stale state, account changes, invalid signer output, and signing exceptions all fail closed.

## Callback artifact

H3B never redirects automatically. A terminal view exposes one explicit `Return to x402eCash` link:

```text
https://x402.ecash.mx/experiments/webmcp/#h3bStatus=signed&challengeId=<challenge>&proof=<canonical-base64url-proof>
https://x402.ecash.mx/experiments/webmcp/#h3bStatus=rejected&challengeId=<challenge>
```

Gate H3C will later define the cross-repository request and proof-return bridge. H3B does not make x402eCash open Tonalli or consume this proof.

## Security and replay boundary

The H3B route calls only `getX402ActiveAccount()` and `signX402AuthorizationMessage(message)`. Private keys remain inside the wallet service. The route performs no fetch, balance lookup, UTXO selection, transaction construction, resource retry, blockchain read, or broadcast.

The short-lived challenge binds the dry-run artifact, but H3B does not claim global or server-backed replay prevention. A later payment gate must add authoritative single-use challenge handling before any payment protocol can rely on this artifact.

## Feature flag and future manual validation

The route is disabled by default:

```dotenv
VITE_X402_H3B_ENABLED=false
```

This pull request does not enable or deploy it. After merge and an independent review, a deliberate build may expose the route only by setting:

```dotenv
VITE_X402_H3B_ENABLED=true
```

For manual validation, use a fresh short-lived canonical request from the reviewed origin, unlock Tonalli through its ordinary onboarding flow, open the fragment URL, verify every displayed field, and exercise Reject and Sign separately. Confirm that signing requires a click, the callback is only a link, the URL fragment is cleared after readiness, no network request occurs, and the returned proof verifies as a message signature over the exact documented canonical message. Do not send funds to the fixture address.
