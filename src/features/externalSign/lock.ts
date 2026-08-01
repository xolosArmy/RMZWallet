export interface UniversalOperationLease {
  readonly ownerOperationId: string
  isOwned(): boolean
  release(): void
}

export interface UniversalOperationLock {
  acquire(operationId: string, signal: AbortSignal): Promise<UniversalOperationLease>
}
