const BACKUP_HANDOFF_TTL_MS = 5 * 60 * 1000

interface PendingBackupSession {
  id: string
  password: string
  expiresAt: number
}

let pendingBackupSession: PendingBackupSession | null = null

const createSessionId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createPendingBackupSession(password: string): string {
  const id = createSessionId()
  pendingBackupSession = {
    id,
    password,
    expiresAt: Date.now() + BACKUP_HANDOFF_TTL_MS
  }
  return id
}

export function readPendingBackupSession(id: string | undefined): string | null {
  if (!id || !pendingBackupSession || pendingBackupSession.id !== id) {
    return null
  }

  if (Date.now() > pendingBackupSession.expiresAt) {
    pendingBackupSession = null
    return null
  }

  return pendingBackupSession.password
}

export function clearPendingBackupSession(id?: string): void {
  if (!pendingBackupSession) return
  if (id && pendingBackupSession.id !== id) return
  pendingBackupSession = null
}
