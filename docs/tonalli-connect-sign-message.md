# Tonalli Connect Sign-Message

## Purpose

`/connect/sign-message` lets an external app request a Tonalli Wallet signature for an exact challenge message without exposing private keys. This is intended for flows such as the eCash México Mining Gateway session handshake.

## URL format

```text
/connect/sign-message?returnUrl=<encoded>&challengeId=<encoded>&message=<encoded>&domain=ecash.mx&purpose=mining-gateway-session
```

Required query params:

- `returnUrl`
- `challengeId`
- `message`

Optional query params:

- `domain`
- `purpose`

## Returned callback payload

Tonalli redirects back to `returnUrl` using hash params:

```text
<returnUrl>#status=ok&wallet=tonalli&chain=ecash&address=<ecash-address>&pubkey=<public-key>&signature=<signature>&challengeId=<challengeId>
```

Success payload fields:

- `status=ok`
- `wallet=tonalli`
- `chain=ecash`
- `address`
- `pubkey`
- `signature`
- `challengeId`

## Error payloads

Tonalli uses hash params for errors as well:

```text
<returnUrl>#status=error&reason=USER_CANCELLED&challengeId=<challengeId>
```

Supported reasons:

- `USER_CANCELLED`
- `WALLET_LOCKED`
- `SIGNING_FAILED`

If required params are missing or `returnUrl` is missing/invalid, Tonalli shows an in-app error screen and does not sign.

## Example Gateway request URL

```text
tonalli://connect/sign-message?returnUrl=https%3A%2F%2Fgateway.ecash.mx%2Ftonalli-callback&challengeId=gw-session-001&message=TONALLI_MINING_GATEWAY%0AchallengeId%3Dgw-session-001%0Adomain%3Decash.mx&domain=ecash.mx&purpose=mining-gateway-session
```

## Example callback URL

```text
https://gateway.ecash.mx/tonalli-callback#status=ok&wallet=tonalli&chain=ecash&address=ecash%3Aqp...&pubkey=02abc...&signature=3044...&challengeId=gw-session-001
```

## Security model

- Tonalli signs only the exact `message` string received in the query parameter.
- Tonalli never exposes the private key or seed through this route.
- The Gateway is responsible for verifying the signature, public key, address, nonce or `challengeId`, and expiration semantics.
- Hash params are preferred so signatures are less likely to appear in server logs.

## Limitations

- `returnUrl` validation is basic and only checks that it parses as a URL.
- There is no production allowlist for requesting domains or callback origins yet.
- Domain and purpose are displayed to the user but are not cryptographically bound by the wallet.

## Future hardening

- Allowlist domains
- Origin binding
- QR/deep-link mobile flow
- Stronger `returnUrl` validation
- User-visible domain verification
