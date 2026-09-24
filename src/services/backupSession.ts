let pendingLocalPassword: string | null = null

export function setPendingBackupPassword(password: string): void {
  pendingLocalPassword = password
}

export function takePendingBackupPassword(): string | null {
  const value = pendingLocalPassword
  pendingLocalPassword = null
  return value
}

export function peekPendingBackupPassword(): string | null {
  return pendingLocalPassword
}
