export const TM_COMM_STAGING_PATH = '/tm-comm-staging'
export const TM_COMM_STAGING_API_PREFIX = '/tm-comm-api'

export const isTmCommStagingEnabled = (
  value: unknown = import.meta.env.VITE_TM_COMM_STAGING
) => String(value).trim().toLowerCase() === 'true'

export const TM_COMM_STAGING_ENABLED = isTmCommStagingEnabled()
