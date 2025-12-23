import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// Configuración Vite + PWA + WASM + COOP/COEP para habilitar SharedArrayBuffer de forma segura.
export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'robots.txt', 'apple-touch-icon.png', 'vite.svg'],
      workbox: {
        // El bundle WASM es grande; ampliamos límite de precache.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024
      },
      manifest: {
        name: 'xolosArmy Wallet',
        short_name: 'xolosWallet',
        description: 'Billetera no custodial para $RMZ y XEC',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/vite.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any'
          },
          {
            src: '/vite.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ]
      }
    })
  ],
  server: {
    headers: {
      // COOP/COEP necesarios para WASM/SharedArrayBuffer seguro en el navegador.
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin'
    },
    proxy: {
      '/chronik': {
        target: 'http://192.168.0.48:8331',
        changeOrigin: true,
        // /chronik/... -> /...
        rewrite: (path) => path.replace(/^\/chronik/, '')
      }
    }
  },
  optimizeDeps: {
    // Evitamos prebundling de WASM del core de la billetera.
    exclude: ['minimal-xec-wallet']
  },
  build: {
    target: 'esnext'
  }
})
