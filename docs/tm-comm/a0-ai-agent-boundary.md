# Future AI agent boundary (A0)

OpenAI is not integrated. This is a capability fence, not an agent runtime.

## Tool classes

### Read tools

Authorized queries only:

- `listAuthorizedConversations`
- `listAuthorizedMessages`

The agent sees only rows the authenticated principal can already see through the ACL.

### Communication tools

- `draftMessage` — enabled. Drafts are not sent.
- `sendMessage` — **disabled**. Remains disabled until a later milestone explicitly enables it.

### Privileged tools

All disabled:

- commercial changes
- logistics changes
- financial operations
- on-chain actions
- Tonalli Memo publication
- wallet capability

## Hard rule

An agent principal never receives a Wallet capability merely because it is authenticated as an agent. Wallet private capabilities stay inside Tonalli's existing Agent Wallet boundary.

`isTmCommAgentSendEnabled()` and `agentAuthenticationGrantsWalletCapability()` are both `false`.
