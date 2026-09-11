/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TonalliMemoComposer } from './TonalliMemoComposer'
import {
  TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES,
  TM1_NFT_DIRECTIVE_BYTES,
  TM1_PROTOCOL_MAX_EVENT_DATA_BYTES,
  tm1EffectiveUserMessageMaxBytes,
  type Tm1PublisherExecutor
} from './types'
import * as nftServiceModule from '../../services/nftService'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function createMockExecutor(overrides: Partial<Tm1PublisherExecutor> = {}): Tm1PublisherExecutor {
  return {
    verifyOwnership: vi.fn().mockResolvedValue({ evidenceToken: 'mock-evidence-token' }),
    requestAuthorization: vi.fn().mockResolvedValue({ authToken: 'mock-auth-token' }),
    prepareAndSign: vi.fn().mockResolvedValue({
      preparedReview: { preparedId: 'prep-123' },
      signedReview: { preparedId: 'prep-123', signature: 'sig-abc' }
    }),
    broadcastAndFinalize: vi.fn().mockResolvedValue({
      txid: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      submissionId: 'sub-001'
    }),
    ...overrides
  }
}

describe('TonalliMemoComposer Integration', () => {
  it('renders initial state with empty editor, unverified identity, and disabled publish button', () => {
    const mockExecutor = createMockExecutor()
    render(<TonalliMemoComposer executor={mockExecutor} initialAlias="satoshi.xec" />)

    // Identity context
    expect(screen.getByTestId('identity-alias').textContent).toBe('satoshi.xec')
    expect(screen.getByTestId('identity-status-unverified')).toBeTruthy()

    // Editor
    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe('')

    // Preview
    expect(screen.getByTestId('preview-empty-state')).toBeTruthy()

    // Publish button disabled when empty
    const btn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain(`0/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes UTF-8`)
  })

  it('updates preview and enables publish button when user types a message', () => {
    const mockExecutor = createMockExecutor()
    render(<TonalliMemoComposer executor={mockExecutor} initialAlias="satoshi.xec" />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    fireEvent.change(textarea, { target: { value: 'Hola Mundo TM1' } })

    // Byte counter updated
    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain('14') // "Hola Mundo TM1" = 14 bytes

    // Canonical preview generated
    expect(screen.queryByTestId('preview-empty-state')).toBeNull()
    expect(screen.getByTestId('preview-active-content')).toBeTruthy()
    expect(screen.getByTestId('script-hex').textContent?.startsWith('6a04544d4d00')).toBe(true)

    // Publish button enabled
    const btn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('allows manual verification of ownership via IdentityContext', async () => {
    const mockExecutor = createMockExecutor()
    render(<TonalliMemoComposer executor={mockExecutor} initialAlias="satoshi.xec" />)

    const verifyBtn = screen.getByTestId('identity-verify-button')
    fireEvent.click(verifyBtn)

    await waitFor(() => {
      expect(mockExecutor.verifyOwnership).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('identity-status-verified')).toBeTruthy()
    })
  })

  it('runs complete state machine lifecycle: Idle -> Verifying -> Authorizing -> Broadcasting -> Success', async () => {
    let resolveVerify: (val: object) => void
    let resolveAuth: (val: object) => void
    let resolveBroadcast: (val: { txid: string }) => void

    const mockExecutor: Tm1PublisherExecutor = {
      verifyOwnership: vi.fn().mockImplementation(() => new Promise((res) => { resolveVerify = res })),
      requestAuthorization: vi.fn().mockImplementation(() => new Promise((res) => { resolveAuth = res })),
      prepareAndSign: vi.fn().mockResolvedValue({
        preparedReview: { preparedId: 'prep-xyz' },
        signedReview: { preparedId: 'prep-xyz', signature: 'sig-xyz' }
      }),
      broadcastAndFinalize: vi.fn().mockImplementation(() => new Promise((res) => { resolveBroadcast = res }))
    }

    const testTxid = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff'
    const handleSuccess = vi.fn()

    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialMessage="Mensaje verificado"
        onSuccess={handleSuccess}
      />
    )

    // 1. Initial idle state
    const publishBtn = screen.getByTestId('publish-button-idle')
    fireEvent.click(publishBtn)

    // 2. Verifying Ownership phase
    await waitFor(() => {
      expect(screen.getByTestId('publish-button-verifying')).toBeTruthy()
      expect(screen.getByTestId('step-ownership').className).toContain('state-step--active')
    })

    // Resolve Step 1
    resolveVerify!({ verified: true })

    // 3. Requesting Authorization phase
    await waitFor(() => {
      expect(screen.getByTestId('publish-button-authorizing')).toBeTruthy()
      expect(screen.getByTestId('step-authorization').className).toContain('state-step--active')
    })

    // Resolve Step 2 & 3
    resolveAuth!({ authorized: true })

    // 4. Broadcasting phase
    await waitFor(() => {
      expect(screen.getByTestId('publish-button-broadcasting')).toBeTruthy()
      expect(screen.getByTestId('step-broadcasting').className).toContain('state-step--active')
    })

    // Resolve Step 4
    resolveBroadcast!({ txid: testTxid })

    // 5. Success phase
    await waitFor(() => {
      expect(screen.getByTestId('publish-success-card')).toBeTruthy()
      expect(screen.getByTestId('success-txid').textContent).toBe(testTxid)
      expect(handleSuccess).toHaveBeenCalledWith(testTxid)
    })

    const explorerLink = screen.getByTestId('explorer-link') as HTMLAnchorElement
    expect(explorerLink.href).toBe(`https://explorer.e.cash/tx/${testTxid}`)

    // Reset back to idle
    const resetBtn = screen.getByTestId('publish-reset-button')
    fireEvent.click(resetBtn)

    await waitFor(() => {
      expect(screen.getByTestId('publish-button-idle')).toBeTruthy()
    })
  })

  it('handles error in state machine and allows retry', async () => {
    const mockExecutor = createMockExecutor({
      broadcastAndFinalize: vi
        .fn()
        .mockRejectedValueOnce(new Error('REJECTED_BY_CONSENSUS_NODE'))
        .mockResolvedValue({
          txid: 'retry-txid-1234567890123456789012345678901234567890123456789012345678901234',
          submissionId: 'retry-sub-001'
        })
    })

    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialMessage="Mensaje con fallo"
      />
    )

    const publishBtn = screen.getByTestId('publish-button-idle')
    fireEvent.click(publishBtn)

    await waitFor(() => {
      expect(screen.getByTestId('publish-error-card')).toBeTruthy()
      expect(screen.getByTestId('publish-error-message').textContent).toContain('REJECTED_BY_CONSENSUS_NODE')
    })

    // Retry should trigger publish again
    const retryBtn = screen.getByTestId('publish-retry-button')
    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(mockExecutor.broadcastAndFinalize).toHaveBeenCalledTimes(2)
      // On second try it succeeds (mock resolved)
      expect(screen.getByTestId('publish-success-card')).toBeTruthy()
    })
  })

  it('opens NFT selector modal, selects an NFT, and renders wire payload in canonical preview', async () => {
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    vi.spyOn(nftServiceModule, 'fetchOwnedNfts').mockResolvedValue([
      {
        tokenId,
        name: 'Xolo Guía Espiritual',
        imageUrl: 'https://ipfs.io/ipfs/QmXolo/image.png'
      }
    ])
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      imageUrl: 'https://ipfs.io/ipfs/QmXolo/image.png',
      metadata: { name: 'Xolo Guía Espiritual' }
    })

    const mockExecutor = createMockExecutor()
    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialOwnerAddress="ecash:qqtest123"
        initialMessage="Acompañado de mi Xolo"
      />
    )

    // Open modal
    const attachBtn = screen.getByTestId('memo-attach-nft-btn')
    fireEvent.click(attachBtn)

    expect(screen.getByTestId('nft-selector-modal')).toBeTruthy()

    // Wait for NFT item to appear
    await waitFor(() => {
      expect(screen.getByTestId(`nft-select-item-${tokenId}`)).toBeTruthy()
      expect(screen.getByText('Xolo Guía Espiritual')).toBeTruthy()
    })

    // Click to select
    fireEvent.click(screen.getByTestId(`nft-select-item-${tokenId}`))

    // Modal closed, selected preview visible
    expect(screen.queryByTestId('nft-selector-modal')).toBeNull()
    expect(screen.getByTestId('memo-selected-nft-preview')).toBeTruthy()
    expect(screen.getByTestId('memo-nft-selection')).toBeTruthy()
    expect(screen.getByTestId('memo-nft-selection-badge').textContent).toBe('NFT seleccionado')
    expect(screen.queryByText('NFT Verificado')).toBeNull()
    expect(screen.queryByTestId('memo-nft-verified')).toBeNull()

    // Wire payload encoded in preview: @nft1:8539...ff8\nAcompañado de mi Xolo
    // 71 bytes directive + 22 bytes text = 93 bytes payload
    const previewContent = screen.getByTestId('preview-active-content')
    expect(previewContent.textContent).toContain('Payload: 93B')
    const expectedHexDirective = Buffer.from(`@nft1:${tokenId}\n`).toString('hex')
    expect(screen.getByTestId('envelope-hex').textContent).toContain(expectedHexDirective)

    // Removing the NFT once details loaded
    const removeBtn = await screen.findByTestId('memo-nft-remove-btn')
    fireEvent.click(removeBtn)

    expect(screen.queryByTestId('memo-selected-nft-preview')).toBeNull()
    expect(screen.getByTestId('memo-attach-nft-btn')).toBeTruthy()
  })

  it('does NOT render "NFT Verificado" when an NFT is attached in the composer', async () => {
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const mockExecutor = createMockExecutor()

    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialOwnerAddress="ecash:qqtest123"
        initialMessage="Hola"
        initialAttachedNft={{ tokenId, name: 'Mi Xolo' }}
      />
    )

    expect(screen.getByTestId('memo-selected-nft-preview')).toBeTruthy()
    expect(screen.getByTestId('memo-nft-selection-badge').textContent).toBe('NFT seleccionado')
    expect(screen.queryByText('NFT Verificado')).toBeNull()
    expect(screen.queryByTestId('memo-nft-verified')).toBeNull()
    expect(screen.queryByText('No verificado')).toBeNull()
  })

  it('allows an NFT-only memo without message text', async () => {
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      metadata: { name: 'Xolo #1' }
    })

    const mockExecutor = createMockExecutor()
    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialOwnerAddress="ecash:qqtest123"
        initialMessage=""
        initialAttachedNft={{ tokenId, name: 'Xolo #1' }}
      />
    )

    // Even with empty text, the wire payload is "@nft1:...\n", which is valid TM1!
    expect(screen.queryByTestId('preview-empty-state')).toBeNull()
    const btn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('verifies JIT ownership and sends canonical wire payload to prepareAndSign during publish', async () => {
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    vi.spyOn(nftServiceModule, 'ownsNftChildToken').mockResolvedValue(true)
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      metadata: { name: 'Xolo #1' }
    })

    const mockExecutor = createMockExecutor()
    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialOwnerAddress="ecash:qqtest123"
        initialMessage="Publicación con NFT"
        initialAttachedNft={{ tokenId, name: 'Xolo #1' }}
      />
    )

    const publishBtn = screen.getByTestId('publish-button-idle')
    fireEvent.click(publishBtn)

    await waitFor(() => {
      expect(mockExecutor.verifyOwnership).toHaveBeenCalled()
      expect(nftServiceModule.ownsNftChildToken).toHaveBeenCalledWith('ecash:qqtest123', tokenId)
      // prepareAndSign MUST receive canonical wire payload!
      expect(mockExecutor.prepareAndSign).toHaveBeenCalledWith(
        expect.anything(),
        `@nft1:${tokenId}\nPublicación con NFT`,
        expect.anything()
      )
      expect(mockExecutor.broadcastAndFinalize).toHaveBeenCalled()
      expect(screen.getByTestId('publish-success-card')).toBeTruthy()
    })
  })

  it('fails closed and blocks prepareAndSign if JIT ownership check returns false', async () => {
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    vi.spyOn(nftServiceModule, 'ownsNftChildToken').mockResolvedValue(false)
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      metadata: { name: 'Xolo #1' }
    })

    const mockExecutor = createMockExecutor()
    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialOwnerAddress="ecash:qqtest123"
        initialMessage="Publicación con NFT transferido"
        initialAttachedNft={{ tokenId, name: 'Xolo #1' }}
      />
    )

    const publishBtn = screen.getByTestId('publish-button-idle')
    fireEvent.click(publishBtn)

    await waitFor(() => {
      expect(mockExecutor.verifyOwnership).toHaveBeenCalled()
      expect(nftServiceModule.ownsNftChildToken).toHaveBeenCalledWith('ecash:qqtest123', tokenId)
      // MUST NOT call prepareAndSign when JIT ownership fails!
      expect(mockExecutor.prepareAndSign).not.toHaveBeenCalled()
      expect(screen.getByTestId('publish-error-card')).toBeTruthy()
      expect(screen.getByTestId('publish-error-message').textContent).toContain(
        'El NFT seleccionado ya no se encuentra en la billetera activa'
      )
    })
  })

  it('preserves plain text and exact eventData in canonical preview when typing URLs', () => {
    const mockExecutor = createMockExecutor()
    render(<TonalliMemoComposer executor={mockExecutor} initialAlias="satoshi.xec" />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    const rawMessage = 'Web: https://xolosarmy.xyz'
    fireEvent.change(textarea, { target: { value: rawMessage } })

    // Canonical preview should show exact raw message encoded in envelope hex
    const envelopeHex = screen.getByTestId('envelope-hex').textContent ?? ''
    const expectedRawHex = Array.from(new TextEncoder().encode(rawMessage))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(envelopeHex).toContain(expectedRawHex)
    // Confirm no HTML '<a' (0x3c61) was injected into the canonical payload
    expect(envelopeHex).not.toContain('3c61')

    // Detected link pill is rendered below textarea
    expect(screen.getByTestId('memo-detected-links').textContent).toContain('https://xolosarmy.xyz')
  })

  it('uses the machine effective limit: 212 without NFT, 141 with NFT, and restores 212 on removal without truncating', async () => {
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    vi.spyOn(nftServiceModule, 'fetchOwnedNfts').mockResolvedValue([
      { tokenId, name: 'Xolo Guía Espiritual', imageUrl: 'https://ipfs.io/ipfs/QmXolo/image.png' }
    ])
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      imageUrl: 'https://ipfs.io/ipfs/QmXolo/image.png',
      metadata: { name: 'Xolo Guía Espiritual' }
    })

    const mockExecutor = createMockExecutor()
    const text180 = 'a'.repeat(180)
    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialOwnerAddress="ecash:qqtest123"
        initialMessage={text180}
      />
    )

    const nftBudget = tm1EffectiveUserMessageMaxBytes(TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES, true)
    expect(nftBudget).toBe(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES - TM1_NFT_DIRECTIVE_BYTES)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe(text180)
    expect(screen.getByTestId('memo-byte-counter').textContent).toContain(
      `180/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes UTF-8`
    )
    expect((screen.getByTestId('publish-button-idle') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId('memo-attach-nft-btn'))
    await waitFor(() => {
      expect(screen.getByTestId(`nft-select-item-${tokenId}`)).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(`nft-select-item-${tokenId}`))

    expect(textarea.value).toBe(text180)
    expect(screen.getByTestId('memo-byte-counter').textContent).toContain(`180/${nftBudget} bytes UTF-8`)
    expect(screen.getByTestId('memo-byte-counter').className).toContain('byte-counter--error')
    expect(screen.getByTestId('memo-overhead-breakdown').textContent).toContain(
      `${180 + TM1_NFT_DIRECTIVE_BYTES}/${TM1_PROTOCOL_MAX_EVENT_DATA_BYTES} bytes`
    )
    expect((screen.getByTestId('publish-button-idle') as HTMLButtonElement).disabled).toBe(true)

    const removeBtn = await screen.findByTestId('memo-nft-remove-btn')
    fireEvent.click(removeBtn)

    expect(textarea.value).toBe(text180)
    expect(screen.getByTestId('memo-byte-counter').textContent).toContain(
      `180/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes UTF-8`
    )
    expect(screen.getByTestId('memo-byte-counter').className).not.toContain('byte-counter--error')
    expect((screen.getByTestId('publish-button-idle') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps NFT + 141 B user text publishable and blocks NFT + 142 B', () => {
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      metadata: { name: 'Xolo #1' }
    })
    const mockExecutor = createMockExecutor()
    const nftBudget = TM1_PROTOCOL_MAX_EVENT_DATA_BYTES - TM1_NFT_DIRECTIVE_BYTES

    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialOwnerAddress="ecash:qqtest123"
        initialMessage={'a'.repeat(nftBudget)}
        initialAttachedNft={{ tokenId, name: 'Xolo #1' }}
      />
    )

    expect(screen.getByTestId('memo-byte-counter').textContent).toContain(`${nftBudget}/${nftBudget} bytes UTF-8`)
    expect((screen.getByTestId('publish-button-idle') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('preview-active-content').textContent).toContain('Payload: 212B')

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    fireEvent.change(textarea, { target: { value: 'a'.repeat(nftBudget + 1) } })

    expect((screen.getByTestId('publish-button-idle') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('preview-error-state').textContent).toContain('213 bytes UTF-8')
  })

  it('publishes a long URL that previously exceeded the 80 B wallet policy without altering the signed payload', async () => {
    const mockExecutor = createMockExecutor()
    const longUrl =
      'https://xolosarmy.xyz/tonalli-memo/protocol/tm1-draft-02/event-data/full-capacity?ref=composer-byte-limit'
    const urlBytes = new TextEncoder().encode(longUrl).length
    expect(urlBytes).toBeGreaterThan(80)
    expect(urlBytes).toBeLessThanOrEqual(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES)

    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialOwnerAddress="ecash:qqtest123"
        initialMessage={longUrl}
      />
    )

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe(longUrl)
    expect(screen.getByTestId('memo-byte-counter').textContent).toContain(
      `${urlBytes}/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes UTF-8`
    )
    expect(screen.getByTestId('memo-detected-links').textContent).toContain(longUrl)

    const envelopeHex = screen.getByTestId('envelope-hex').textContent ?? ''
    const expectedRawHex = Array.from(new TextEncoder().encode(longUrl))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(envelopeHex).toContain(expectedRawHex)
    expect(envelopeHex).not.toContain('3c61')

    const publishBtn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
    expect(publishBtn.disabled).toBe(false)
    fireEvent.click(publishBtn)

    await waitFor(() => {
      expect(mockExecutor.prepareAndSign).toHaveBeenCalledWith(
        expect.anything(),
        longUrl,
        expect.anything()
      )
      expect(screen.getByTestId('publish-success-card')).toBeTruthy()
    })
  })

  it('accepts exact plain 212 B in canonical preview and rejects 213 B', () => {
    const mockExecutor = createMockExecutor()
    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialAlias="satoshi.xec"
        initialMessage={'a'.repeat(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES)}
      />
    )

    expect(screen.getByTestId('preview-active-content').textContent).toContain('Payload: 212B')
    expect((screen.getByTestId('publish-button-idle') as HTMLButtonElement).disabled).toBe(false)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    fireEvent.change(textarea, { target: { value: 'a'.repeat(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES + 1) } })

    expect(screen.getByTestId('preview-error-state').textContent).toContain('213 bytes UTF-8')
    expect((screen.getByTestId('publish-button-idle') as HTMLButtonElement).disabled).toBe(true)
  })
})
