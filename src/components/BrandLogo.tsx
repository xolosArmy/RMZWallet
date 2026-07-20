import logoOfficial from '../assets/brand/tonalli-wallet-logo-official.jpeg'
import pictogramDerived from '../assets/brand/tonalli-wallet-pictogram-derived.png'

type BrandLogoProps = {
  variant?: 'primary' | 'pictogram'
  size?: number | string
  alt?: string
  className?: string
}

function BrandLogo({
  variant = 'primary',
  size,
  alt = variant === 'primary' ? 'Logotipo oficial de Tonalli Wallet' : 'Pictograma Tonalli Wallet',
  className = ''
}: BrandLogoProps) {
  const width = size ?? (variant === 'primary' ? 180 : 44)
  const height = variant === 'primary' ? 'auto' : width

  return (
    <img
      className={`brand-logo brand-logo-${variant} ${className}`.trim()}
      src={variant === 'primary' ? logoOfficial : pictogramDerived}
      alt={alt}
      width={typeof width === 'number' ? width : undefined}
      height={typeof height === 'number' ? height : undefined}
      loading="eager"
      decoding="async"
      style={{
        width,
        height,
        aspectRatio: variant === 'primary' ? '1 / 1' : '1 / 1',
        objectFit: 'contain'
      }}
    />
  )
}

export default BrandLogo
