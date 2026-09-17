# Tonalli Memo frontier (M3)

Tonalli Memo is expressly out of A0, M0, M1, and M2 except for this contract.

A private conversation is never published automatically.

`TM_COMM_AUTOMATIC_MEMO_PUBLICATION = false`.

A future event that *might* become a Memo must follow:

```text
private event
→ candidate evidence
→ public preview
→ human approval
→ Wallet authorization / signature when applicable
→ Tonalli Memo
```

There is no shortcut from a TM-COMM message to OP_RETURN, broadcast, or Memo feed ingestion.
