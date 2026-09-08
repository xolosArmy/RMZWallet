/**
 * @vitest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTm1PublishMachine } from './useTm1PublishMachine'
import type { Tm1PublisherExecutor } from './types'

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
})
