export const isAgentApprovalEnabled = (
  value: unknown = import.meta.env?.VITE_AGENT_APPROVAL_ENABLED
): boolean => String(value).trim().toLowerCase() === 'true'

export const AGENT_APPROVAL_ENABLED = isAgentApprovalEnabled()
