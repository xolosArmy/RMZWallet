/**
 * @vitest-environment jsdom
 */
import { renderHook, act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTm1PublishMachine } from './useTm1PublishMachine'
import TonalliMemoComposer from './TonalliMemoComposer'
import type { Tm1PublisherExecutor } from './types'
import * as nftServiceModule from '../../services/nftService'

function createMockExecutor(overrides: Partial<Tm1PublisherExecutor> = {}): Tm1PublisherExecutor {
  return {
    verifyOwnership: vi.fn().mockResolvedValue({ evidenceToken: 'mock-evidence' }),
    requestAuthorization: vi.fn().mockResolvedValue({ authToken: 'mock-auth' }),
    prepareAndSign: vi.fn().mockResolvedValue({
      preparedReview: { preparedId: 'prep-1' },
      signedReview: { preparedId: 'prep-1', signature: 'sig-1' }
    }),
    broadcastAndFinalize: vi.fn().mockResolvedValue({
      txid: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      submissionId: 'sub-1'
    }),
    ...overrides
  }
}

describe('useTm1PublishMachine Hook', () => {
  describe('Finding 1: Require Tm1PublisherExecutor without fallback', () => {
    it('throws EXECUTOR_REQUIRED error when no executor is provided', () => {
      expect(() => {
        // @ts-expect-error intentionally testing missing executor
        renderHook(() => useTm1PublishMachine({}))
      }).toThrow(/EXECUTOR_REQUIRED/)
    })

    it('initializes successfully when an explicit executor is provided', () => {
      const mockExecutor = createMockExecutor()
      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialAlias: 'alice.xec',
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
        })
      )

      expect(result.current.state.alias).toBe('alice.xec')
      expect(result.current.state.phase).toBe('idle')
    })
  })

  describe('Finding 3: Canonical preview as sole authority for isValid', () => {
    it('marks isValid false when message is empty (preview null, previewError undefined)', () => {
      const mockExecutor = createMockExecutor()
      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: ''
        })
      )

      expect(result.current.state.message).toBe('')
      expect(result.current.state.preview).toBeNull()
      expect(result.current.state.previewData).toBeNull()
      expect(result.current.state.previewError).toBeNull()
      expect(result.current.state.isValid).toBe(false)
    })

    it('marks isValid true when canonical encoding succeeds (preview non-null, previewError undefined)', () => {
      const mockExecutor = createMockExecutor()
      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: 'Mensaje válido TM1'
        })
      )

      expect(result.current.state.preview).not.toBeNull()
      expect(result.current.state.previewData).toEqual(result.current.state.preview)
      expect(result.current.state.previewError).toBeNull()
      expect(result.current.state.isValid).toBe(true)
    })

    it('marks isValid false when canonical encoding fails (e.g. exceeds strict 80-byte encoder limit)', () => {
      const mockExecutor = createMockExecutor()
      // 81 bytes exceeds the strict 80-byte Draft 0.2 limit
      const overLimitMessage = 'A'.repeat(81)

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: overLimitMessage
        })
      )

      expect(result.current.state.preview).toBeNull()
      expect(result.current.state.previewData).toBeNull()
      expect(result.current.state.previewError).toBeTruthy()
      expect(result.current.state.previewError).toContain('81 bytes UTF-8')
      expect(result.current.state.isValid).toBe(false)
    })

    it('marks isValid false if isOverLimit is true, even when canonical preview is non-null', () => {
      const mockExecutor = createMockExecutor()
      // Message has 30 bytes, which is valid for TM1 (<=80 bytes), but exceeds custom maxBytes of 20
      const message = '123456789012345678901234567890'

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: message,
          maxBytes: 20
        })
      )

      expect(result.current.state.preview).not.toBeNull()
      expect(result.current.state.previewError).toBeNull()
      expect(result.current.state.isOverLimit).toBe(true)
      expect(result.current.state.isValid).toBe(false)
    })

    it('marks isValid true when message is within custom maxBytes limit and preview is valid', () => {
      const mockExecutor = createMockExecutor()
      const message = '1234567890'

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: message,
          maxBytes: 20
        })
      )

      expect(result.current.state.preview).not.toBeNull()
      expect(result.current.state.previewError).toBeNull()
      expect(result.current.state.isOverLimit).toBe(false)
      expect(result.current.state.isValid).toBe(true)
    })

    it('refuses to invoke publish if isValid is false', async () => {
      const mockExecutor = createMockExecutor()
      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: '' // empty, so isValid is false
        })
      )

      await act(async () => {
        await result.current.publish()
      })

      expect(mockExecutor.verifyOwnership).not.toHaveBeenCalled()
      expect(mockExecutor.broadcastAndFinalize).not.toHaveBeenCalled()
      expect(result.current.state.phase).toBe('idle')
    })
  })

  describe('Full State Machine Flow', () => {
    it('progresses through verifying_ownership -> requesting_authorization -> broadcasting -> success', async () => {
      const mockExecutor = createMockExecutor()
      const onSuccess = vi.fn()
      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: 'Test publish flow',
          initialAlias: 'alice.xec',
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq',
          onSuccess
        })
      )

      expect(result.current.state.isValid).toBe(true)

      await act(async () => {
        await result.current.publish()
      })

      expect(mockExecutor.verifyOwnership).toHaveBeenCalledTimes(1)
      expect(mockExecutor.requestAuthorization).toHaveBeenCalledTimes(1)
      expect(mockExecutor.prepareAndSign).toHaveBeenCalledTimes(1)
      expect(mockExecutor.broadcastAndFinalize).toHaveBeenCalledTimes(1)

      expect(result.current.state.phase).toBe('success')
      expect(result.current.state.txid).toBe(
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      )
      expect(onSuccess).toHaveBeenCalledWith(
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      )
    })

    it('preserves success phase and txid when onSuccess callback throws an error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockExecutor = createMockExecutor()
      const throwingOnSuccess = vi.fn().mockImplementation(() => {
        throw new Error('UI callback runtime failure')
      })
      const onError = vi.fn()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: 'Test callback error isolation',
          initialAlias: 'alice.xec',
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq',
          onSuccess: throwingOnSuccess,
          onError
        })
      )

      await act(async () => {
        await result.current.publish()
      })

      expect(throwingOnSuccess).toHaveBeenCalledWith(
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      )
      expect(result.current.state.phase).toBe('success')
      expect(result.current.state.txid).toBe(
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      )
      expect(result.current.state.error).toBeNull()
      expect(onError).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('transitions to error phase when an executor step throws', async () => {
      const mockExecutor = createMockExecutor({
        verifyOwnership: vi.fn().mockRejectedValue(new Error('ALIAS_NOT_FOUND'))
      })
      const onError = vi.fn()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: 'Failing verification test',
          onError
        })
      )

      await act(async () => {
        await result.current.publish()
      })

      expect(result.current.state.phase).toBe('error')
      expect(result.current.state.error).toBe('ALIAS_NOT_FOUND')
      expect(onError).toHaveBeenCalledWith(expect.any(Error))
    })

    it('resets state back to idle on reset()', async () => {
      const mockExecutor = createMockExecutor({
        verifyOwnership: vi.fn().mockRejectedValue(new Error('Network error'))
      })

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialMessage: 'Reset test'
        })
      )

      await act(async () => {
        await result.current.publish()
      })
      expect(result.current.state.phase).toBe('error')

      act(() => {
        result.current.reset()
      })

      expect(result.current.state.phase).toBe('idle')
      expect(result.current.state.error).toBeNull()
      expect(result.current.state.txid).toBeNull()
    })
  })

  describe('Finding 2: Do not discard outcome-unknown without proof', () => {
    const createOutcomeUnknownPendingRecord = (overrides: Partial<any> = {}) => ({
      publicationId: 'pending-pub-outcome-unknown',
      phase: 'outcomeUnknown',
      revision: 2,
      ownerEpoch: 1,
      dispatchIntent: {
        submissionId: 'sub-test',
        txid: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        signedArtifactHash: '11'.repeat(32),
        broadcastCapabilityId: 'cap-broadcast-1',
        committedAt: Date.now()
      },
      broadcastAuthorization: {
        expiresAt: Date.now() + 3600000 // expires in 1 hour (not expired)
      },
      ...overrides
    })

    it('rejects arbitrary manual removal of outcomeUnknown records without network proof', async () => {
      const mockRemove = vi.fn()
      const mockRecoveryStore = {
        storeId: 'test-store',
        createdAt: Date.now(),
        load: vi.fn(),
        listRecoverable: vi.fn().mockResolvedValue([createOutcomeUnknownPendingRecord()]),
        create: vi.fn(),
        commitExecutionEvidence: vi.fn(),
        commitDispatchIntent: vi.fn(),
        commitTransportAcknowledgement: vi.fn(),
        commitRecoveryTransition: vi.fn(),
        claimOwnership: vi.fn(),
        remove: mockRemove,
        clear: vi.fn()
      }
      const mockExecutor = createMockExecutor()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          recoveryStore: mockRecoveryStore as any,
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
        })
      )

      // Wait for reconciliation check to mount pendingRecord
      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.state.phase).toBe('reconciling')
      expect(result.current.state.pendingRecord).toBeDefined()
      expect((result.current.state.pendingRecord as any)?.phase).toBe('outcomeUnknown')

      // Attempting to arbitrarily dismiss/remove an outcomeUnknown record must throw and NOT call remove()
      await expect(
        act(async () => {
          await result.current.dismissPending()
        })
      ).rejects.toThrow(/CANNOT_DISCARD_OUTCOME_UNKNOWN/)

      expect(mockRemove).not.toHaveBeenCalled()
      expect(result.current.state.phase).toBe('reconciling')
      expect(result.current.state.pendingRecord).not.toBeNull()
    })

    it('does not remove outcomeUnknown record if Chronik reports 404 even when safe expiration has elapsed', async () => {
      const mockRemove = vi.fn()
      const pastTime = Date.now() - 10000 // expired 10s ago
      const pendingRec = createOutcomeUnknownPendingRecord({
        broadcastAuthorization: { expiresAt: pastTime },
        signingAuthorization: { expiresAt: pastTime }
      })
      const mockRecoveryStore = {
        storeId: 'test-store',
        createdAt: Date.now(),
        load: vi.fn(),
        listRecoverable: vi.fn().mockResolvedValue([pendingRec]),
        create: vi.fn(),
        commitExecutionEvidence: vi.fn(),
        commitDispatchIntent: vi.fn(),
        commitTransportAcknowledgement: vi.fn(),
        commitRecoveryTransition: vi.fn(),
        claimOwnership: vi.fn(),
        remove: mockRemove,
        clear: vi.fn()
      }
      const mockChronik = {
        tx: vi.fn().mockRejectedValue(new Error('404 Not Found'))
      }
      const mockExecutor = createMockExecutor({
        signer: { chronik: mockChronik }
      } as any)

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          recoveryStore: mockRecoveryStore as any,
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
        })
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.state.phase).toBe('reconciling')

      // Attempt reconcile when tx returns 404 from Chronik
      await act(async () => {
        await result.current.reconcilePending()
      })

      // Finding 2: Absence of evidence is not evidence of absence.
      // Must NOT remove the record or transition away from reconciling on 404.
      expect(mockRemove).not.toHaveBeenCalled()
      expect(result.current.state.phase).toBe('reconciling')
      expect(result.current.state.pendingRecord).not.toBeNull()
    })

    it('acknowledges and clears pending record only when Chronik confirms txid', async () => {
      const pendingRec = createOutcomeUnknownPendingRecord()
      let pendingList = [pendingRec]
      const mockAck = vi.fn().mockImplementation(async () => {
        pendingList = []
        return true
      })
      const mockRecoveryStore = {
        storeId: 'test-store',
        createdAt: Date.now(),
        load: vi.fn(),
        listRecoverable: vi.fn().mockImplementation(async () => pendingList),
        create: vi.fn(),
        commitExecutionEvidence: vi.fn(),
        commitDispatchIntent: vi.fn(),
        commitTransportAcknowledgement: mockAck,
        commitRecoveryTransition: vi.fn(),
        claimOwnership: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn()
      }
      const mockChronik = {
        tx: vi.fn().mockResolvedValue({ txid: pendingRec.dispatchIntent!.txid })
      }
      const mockExecutor = createMockExecutor({
        signer: { chronik: mockChronik }
      } as any)

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          recoveryStore: mockRecoveryStore as any,
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
        })
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.state.phase).toBe('reconciling')

      // Attempt reconcile when Chronik confirms tx
      await act(async () => {
        await result.current.reconcilePending()
      })

      expect(mockAck).toHaveBeenCalled()
      expect(result.current.state.phase).toBe('idle')
      expect(result.current.state.pendingRecord).toBeNull()
    })

    it('Strict Rule 2: rechecks pending records after resolving one and stays in reconciling phase if another pending record remains', async () => {
      const pendingRec1 = createOutcomeUnknownPendingRecord({
        publicationId: 'pub-rec-1',
        dispatchIntent: {
          txid: 'txid-1111',
          submissionId: 'sub-1',
          committedAt: 1000,
          signedArtifactHash: 'hash-1'
        }
      })
      const pendingRec2 = createOutcomeUnknownPendingRecord({
        publicationId: 'pub-rec-2',
        dispatchIntent: {
          txid: 'txid-2222',
          submissionId: 'sub-2',
          committedAt: 2000,
          signedArtifactHash: 'hash-2'
        }
      })

      let pendingList = [pendingRec1, pendingRec2]
      const mockAck = vi.fn().mockImplementation(async (params: any) => {
        pendingList = pendingList.filter((r) => r.publicationId !== params.publicationId)
        return true
      })

      const mockRecoveryStore = {
        storeId: 'test-store',
        createdAt: Date.now(),
        load: vi.fn(),
        listRecoverable: vi.fn().mockImplementation(async () => pendingList),
        create: vi.fn(),
        commitExecutionEvidence: vi.fn(),
        commitDispatchIntent: vi.fn(),
        commitTransportAcknowledgement: mockAck,
        commitRecoveryTransition: vi.fn(),
        claimOwnership: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn()
      }

      const mockChronik = {
        tx: vi.fn().mockImplementation(async (txid: string) => {
          return { txid }
        })
      }
      const mockExecutor = createMockExecutor({
        signer: { chronik: mockChronik }
      } as any)

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          recoveryStore: mockRecoveryStore as any,
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
        })
      )

      await act(async () => {
        await Promise.resolve()
      })

      // Initially in reconciling with pendingRec1
      expect(result.current.state.phase).toBe('reconciling')
      expect((result.current.state.pendingRecord as any)?.publicationId).toBe('pub-rec-1')

      // Reconcile pending publication 1
      await act(async () => {
        await result.current.reconcilePending()
      })

      // Finding 2 (Strict Rule 2):
      // Machine must NOT transition to idle. It must stay in reconciling with pendingRec2!
      expect(mockAck).toHaveBeenCalledTimes(1)
      expect(result.current.state.phase).toBe('reconciling')
      expect((result.current.state.pendingRecord as any)?.publicationId).toBe('pub-rec-2')

      // Reconcile pending publication 2
      await act(async () => {
        await result.current.reconcilePending()
      })

      // Both resolved, now machine transitions to idle
      expect(mockAck).toHaveBeenCalledTimes(2)
      expect(result.current.state.phase).toBe('idle')
      expect(result.current.state.pendingRecord).toBeNull()
    })

    it('Finding 1: fences retries into reconciling phase when a transport error occurs post-dispatch', async () => {
      const pendingRec = createOutcomeUnknownPendingRecord()
      let hasCommittedDispatch = false

      const mockRecoveryStore = {
        storeId: 'test-store',
        createdAt: Date.now(),
        load: vi.fn(),
        listRecoverable: vi.fn().mockImplementation(() => {
          return Promise.resolve(hasCommittedDispatch ? [pendingRec] : [])
        }),
        create: vi.fn(),
        commitExecutionEvidence: vi.fn(),
        commitDispatchIntent: vi.fn(),
        commitTransportAcknowledgement: vi.fn(),
        commitRecoveryTransition: vi.fn(),
        claimOwnership: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn()
      }

      const mockExecutor = createMockExecutor({
        broadcastAndFinalize: vi.fn().mockImplementation(async () => {
          // Simulate commitDispatchIntent having succeeded in storage before transport fails
          hasCommittedDispatch = true
          throw new Error('NETWORK_TIMEOUT: Broadcast timed out')
        })
      })

      const onErrorMock = vi.fn()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          recoveryStore: mockRecoveryStore as any,
          initialAlias: 'alice.xec',
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq',
          initialMessage: 'Mensaje de prueba',
          onError: onErrorMock
        })
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.state.phase).toBe('idle')
      expect(result.current.state.isValid).toBe(true)

      // Trigger publish which will fail post-dispatch
      await act(async () => {
        await result.current.publish()
      })

      // Finding 1: The machine must NOT be in 'error' phase.
      // It must transition to 'reconciling' with the pending record, fencing retries.
      expect(onErrorMock).toHaveBeenCalledWith(expect.any(Error))
      expect(result.current.state.phase).toBe('reconciling')
      expect(result.current.state.pendingRecord).toEqual(pendingRec)
      expect(result.current.state.isValid).toBe(false)
    })

    it('Finding 1: fences publishing immediately in reconciling phase when recoveryStore is present until check completes', async () => {
      let resolveRecoverable: (val: any) => void = () => {}
      const pendingPromise = new Promise((resolve) => {
        resolveRecoverable = resolve
      })
      const mockRecoveryStore = {
        storeId: 'test-store',
        createdAt: Date.now(),
        listRecoverable: vi.fn().mockReturnValue(pendingPromise)
      }
      const mockExecutor = createMockExecutor()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          recoveryStore: mockRecoveryStore as any,
          initialAlias: 'alice.xec',
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq',
          initialMessage: 'Mensaje inmediato'
        })
      )

      // 1. Immediately on mount, before listRecoverable resolves:
      // Machine must be in 'reconciling' and isValid must be false
      expect(result.current.state.phase).toBe('reconciling')
      expect(result.current.state.isValid).toBe(false)

      // 2. An attempt to publish while lookup is in-flight must be completely ignored/fenced
      await act(async () => {
        await result.current.publish()
      })
      expect(mockExecutor.verifyOwnership).not.toHaveBeenCalled()
      expect(mockExecutor.broadcastAndFinalize).not.toHaveBeenCalled()

      // 3. Once listRecoverable resolves with no pending records, transitions to idle
      await act(async () => {
        resolveRecoverable([])
      })
      expect(result.current.state.phase).toBe('idle')
      expect(result.current.state.isValid).toBe(true)
    })

    it('Finding 1: fails closed when listRecoverable throws, keeping publishing fenced in reconciling phase without transitioning to idle', async () => {
      const storageError = new Error('DURABLE_STORAGE_READ_ERROR: Quota or permission failure')
      const mockRecoveryStore = {
        storeId: 'test-store',
        createdAt: Date.now(),
        listRecoverable: vi.fn().mockRejectedValue(storageError)
      }
      const mockExecutor = createMockExecutor()
      const onErrorMock = vi.fn()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          recoveryStore: mockRecoveryStore as any,
          initialAlias: 'alice.xec',
          initialOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq',
          initialMessage: 'Mensaje con fallo de lectura de recuperación',
          onError: onErrorMock
        })
      )

      // Wait for initial checkRecovery effect to settle
      await act(async () => {
        await Promise.resolve()
      })

      // 1. Strict assert: Phase must NOT transition to 'idle', it must remain 'reconciling'
      expect(result.current.state.phase).not.toBe('idle')
      expect(result.current.state.phase).toBe('reconciling')

      // 2. Strict assert: Publishing must remain fenced (isValid = false)
      expect(result.current.state.isValid).toBe(false)
      expect(result.current.state.error).toBe('DURABLE_STORAGE_READ_ERROR: Quota or permission failure')
      expect(onErrorMock).toHaveBeenCalledWith(storageError)

      // 3. Strict assert: Calling publish() is rejected and does not proceed to network
      await act(async () => {
        await result.current.publish()
      })
      expect(mockExecutor.verifyOwnership).not.toHaveBeenCalled()
      expect(mockExecutor.broadcastAndFinalize).not.toHaveBeenCalled()
    })

    it('Finding 1: UI button remains disabled and fenced in reconciling phase when recovery lookup fails', async () => {
      const storageError = new Error('STORAGE_UNAVAILABLE')
      const mockRecoveryStore = {
        storeId: 'test-store',
        createdAt: Date.now(),
        listRecoverable: vi.fn().mockRejectedValue(storageError)
      }
      const mockExecutor = createMockExecutor()

      render(
        <TonalliMemoComposer
          initialAlias="alice.xec"
          initialOwnerAddress="ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq"
          initialMessage="Mensaje de prueba UI"
          executor={mockExecutor}
          recoveryStore={mockRecoveryStore as any}
        />
      )

      await act(async () => {
        await Promise.resolve()
      })

      // 1. Strict assert: publish-button-idle must NOT be rendered
      expect(screen.queryByTestId('publish-button-idle')).toBeNull()

      // 2. Strict assert: publish-button-reconciling is rendered and strictly disabled
      const reconcilingBtn = screen.getByTestId('publish-button-reconciling') as HTMLButtonElement
      expect(reconcilingBtn).toBeDefined()
      expect(reconcilingBtn.disabled).toBe(true)

      // 3. Strict assert: reconciliation notice displays failure warning
      expect(screen.getByTestId('memo-reconciling-state')).toBeDefined()
      expect(screen.getByTestId('reconciliation-error-text').textContent).toContain('STORAGE_UNAVAILABLE')
    })
  })

  describe('NFT attachment integration in useTm1PublishMachine', () => {
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const ownerAddress = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'

    it('preserves configurable maxBytes while counting attachment overhead against protocol wire limit 212', () => {
      const mockExecutor = createMockExecutor()
      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialAlias: 'alice.xec',
          initialOwnerAddress: ownerAddress,
          initialMessage: 'x'.repeat(50),
          maxBytes: 50 // custom limit
        })
      )

      expect(result.current.state.userMessageByteLength).toBe(50)
      expect(result.current.state.isValid).toBe(true)

      // Attach NFT: directive overhead is 71 bytes. Wire total = 50 + 71 = 121 bytes <= 212.
      act(() => {
        result.current.setAttachedNft({ tokenId, name: 'Xolo #1' })
      })

      expect(result.current.state.attachedNft?.tokenId).toBe(tokenId)
      expect(result.current.state.wirePayload).toBe(`@nft1:${tokenId}\n${'x'.repeat(50)}`)
      expect(result.current.state.wirePayloadByteLength).toBe(121)
      expect(result.current.state.userMessageByteLength).toBe(50)
      // Attachment overhead does NOT consume visual userMessage budget:
      expect(result.current.state.isValid).toBe(true)

      // Exceeding custom user maxBytes makes it invalid:
      act(() => {
        result.current.setMessage('x'.repeat(51))
      })
      expect(result.current.state.isValid).toBe(false)

      // Setting message within custom limit (50) makes it valid again:
      act(() => {
        result.current.setMessage('x'.repeat(50))
      })
      expect(result.current.state.isValid).toBe(true)

      // If wire payload were to exceed TM1_PROTOCOL_MAX_EVENT_DATA_BYTES (212), state becomes invalid:
      // With 71 B directive, max remaining for wire is 212 - 71 = 141 B.
      // If options.maxBytes was e.g. 200, but user typed 150 B:
      // wire would be 150 + 71 = 221 B > 212 B -> invalid!
    })

    it('enables publication for NFT-only memo (empty user text)', () => {
      const mockExecutor = createMockExecutor()
      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialAlias: 'alice.xec',
          initialOwnerAddress: ownerAddress,
          initialMessage: '',
          initialAttachedNft: { tokenId, name: 'Xolo #1' }
        })
      )

      expect(result.current.state.message).toBe('')
      expect(result.current.state.userMessageByteLength).toBe(0)
      expect(result.current.state.attachedNft?.tokenId).toBe(tokenId)
      expect(result.current.state.wirePayload).toBe(`@nft1:${tokenId}\n`)
      expect(result.current.state.wirePayloadByteLength).toBe(71)
      expect(result.current.state.isValid).toBe(true)
      expect(result.current.state.preview).not.toBeNull()
      expect(result.current.state.preview?.eventDataByteLength).toBe(71)
    })

    it('clears attached NFT when ownerAddress changes', () => {
      const mockExecutor = createMockExecutor()
      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialAlias: 'alice.xec',
          initialOwnerAddress: ownerAddress,
          initialMessage: 'Hola',
          initialAttachedNft: { tokenId, name: 'Xolo #1' }
        })
      )

      expect(result.current.state.attachedNft).not.toBeNull()
      expect(result.current.state.wirePayload).toContain(`@nft1:${tokenId}`)

      // Change address:
      act(() => {
        result.current.setOwnerAddress('ecash:qznewaddress999999999999999999999999999999')
      })

      expect(result.current.state.attachedNft).toBeNull()
      expect(result.current.state.wirePayload).toBe('Hola')
    })

    it('revalidates ownership JIT via ownsNftChildToken before calling prepareAndSign', async () => {
      vi.spyOn(nftServiceModule, 'ownsNftChildToken').mockResolvedValue(true)
      const mockExecutor = createMockExecutor()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialAlias: 'alice.xec',
          initialOwnerAddress: ownerAddress,
          initialMessage: 'Publicando con NFT',
          initialAttachedNft: { tokenId, name: 'Xolo #1' }
        })
      )

      await act(async () => {
        await result.current.publish()
      })

      expect(nftServiceModule.ownsNftChildToken).toHaveBeenCalledWith(ownerAddress, tokenId)
      expect(mockExecutor.prepareAndSign).toHaveBeenCalledWith(
        expect.anything(),
        `@nft1:${tokenId}\nPublicando con NFT`,
        expect.anything()
      )
      expect(mockExecutor.broadcastAndFinalize).toHaveBeenCalled()
      expect(result.current.state.phase).toBe('success')
    })

    it('fails closed and blocks prepareAndSign if JIT ownership verification returns false', async () => {
      vi.spyOn(nftServiceModule, 'ownsNftChildToken').mockResolvedValue(false)
      const mockExecutor = createMockExecutor()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialAlias: 'alice.xec',
          initialOwnerAddress: ownerAddress,
          initialMessage: 'Publicando con NFT no poseído',
          initialAttachedNft: { tokenId, name: 'Xolo #1' }
        })
      )

      await act(async () => {
        await result.current.publish()
      })

      expect(nftServiceModule.ownsNftChildToken).toHaveBeenCalledWith(ownerAddress, tokenId)
      expect(mockExecutor.prepareAndSign).not.toHaveBeenCalled()
      expect(result.current.state.phase).toBe('error')
      expect(result.current.state.error).toContain(
        'El NFT seleccionado ya no se encuentra en la billetera activa'
      )
    })

    it('fails closed and blocks prepareAndSign if Chronik JIT check rejects', async () => {
      vi.spyOn(nftServiceModule, 'ownsNftChildToken').mockRejectedValue(new Error('CHRONIK_OFFLINE'))
      const mockExecutor = createMockExecutor()

      const { result } = renderHook(() =>
        useTm1PublishMachine({
          executor: mockExecutor,
          initialAlias: 'alice.xec',
          initialOwnerAddress: ownerAddress,
          initialMessage: 'Publicando con Chronik caído',
          initialAttachedNft: { tokenId, name: 'Xolo #1' }
        })
      )

      await act(async () => {
        await result.current.publish()
      })

      expect(nftServiceModule.ownsNftChildToken).toHaveBeenCalledWith(ownerAddress, tokenId)
      expect(mockExecutor.prepareAndSign).not.toHaveBeenCalled()
      expect(result.current.state.phase).toBe('error')
      expect(result.current.state.error).toContain('CHRONIK_OFFLINE')
    })
  })
})
