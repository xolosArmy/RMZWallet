/**
 * Future AI agent capability boundary (A0 contract only).
 *
 * OpenAI is not integrated. An authenticated agent principal never
 * receives a Wallet capability. Send remains disabled until a later
 * milestone explicitly enables it.
 */

export const TM_COMM_AGENT_TOOL_CLASSES = Object.freeze([
  'read',
  'communication',
  'privileged'
] as const)

export type TmCommAgentToolClass = (typeof TM_COMM_AGENT_TOOL_CLASSES)[number]

export type TmCommAgentTool = Readonly<{
  class: TmCommAgentToolClass
  name: string
  enabled: boolean
  description: string
}>

export const TM_COMM_AGENT_READ_TOOLS = Object.freeze([
  Object.freeze({
    class: 'read',
    name: 'listAuthorizedConversations',
    enabled: true,
    description: 'List conversations the authenticated principal is bound to.'
  }),
  Object.freeze({
    class: 'read',
    name: 'listAuthorizedMessages',
    enabled: true,
    description: 'Read messages inside an authorized conversation only.'
  })
] as const satisfies readonly TmCommAgentTool[])

export const TM_COMM_AGENT_COMMUNICATION_TOOLS = Object.freeze([
  Object.freeze({
    class: 'communication',
    name: 'draftMessage',
    enabled: true,
    description: 'Draft a private reply. Drafts are not sent.'
  }),
  Object.freeze({
    class: 'communication',
    name: 'sendMessage',
    enabled: false,
    description: 'Send a private message. Disabled in A0; remains off until M2.'
  })
] as const satisfies readonly TmCommAgentTool[])

export const TM_COMM_AGENT_PRIVILEGED_TOOLS = Object.freeze([
  Object.freeze({
    class: 'privileged',
    name: 'commercialChange',
    enabled: false,
    description: 'Change reservation commercial terms.'
  }),
  Object.freeze({
    class: 'privileged',
    name: 'logisticsChange',
    enabled: false,
    description: 'Change logistics or stay operations.'
  }),
  Object.freeze({
    class: 'privileged',
    name: 'financialOperation',
    enabled: false,
    description: 'Any movement of funds, invoices, or settlement.'
  }),
  Object.freeze({
    class: 'privileged',
    name: 'onChainAction',
    enabled: false,
    description: 'Any on-chain mutation.'
  }),
  Object.freeze({
    class: 'privileged',
    name: 'memoPublication',
    enabled: false,
    description: 'Tonalli Memo publication. Out of A0/M0/M1/M2.'
  }),
  Object.freeze({
    class: 'privileged',
    name: 'walletCapability',
    enabled: false,
    description: 'Wallet private capabilities. Never granted by agent authentication.'
  })
] as const satisfies readonly TmCommAgentTool[])

export const TM_COMM_AGENT_TOOL_REGISTRY = Object.freeze({
  read: TM_COMM_AGENT_READ_TOOLS,
  communication: TM_COMM_AGENT_COMMUNICATION_TOOLS,
  privileged: TM_COMM_AGENT_PRIVILEGED_TOOLS
})

export function isTmCommAgentSendEnabled(): boolean {
  return TM_COMM_AGENT_COMMUNICATION_TOOLS.some(
    tool => tool.name === 'sendMessage' && tool.enabled
  )
}

export function agentAuthenticationGrantsWalletCapability(): boolean {
  return TM_COMM_AGENT_PRIVILEGED_TOOLS.some(
    tool => tool.name === 'walletCapability' && tool.enabled
  )
}
