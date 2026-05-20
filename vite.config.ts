import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// Configuración Vite + PWA + WASM + COOP/COEP para habilitar SharedArrayBuffer de forma segura.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiProxyTarget = env.VITE_API_PROXY_TARGET
  const apiProxyProvider = env.VITE_API_PROXY_PROVIDER

  return {
    define: {
      global: 'globalThis'
    },
    resolve: {
      alias: {
        buffer: 'buffer'
      }
    },
    plugins: [
      react(),
      wasm(),
      topLevelAwait(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'robots.txt', 'apple-touch-icon.png', 'vite.svg'],
        workbox: {
          // El bundle WASM es grande; ampliamos límite de precache.
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024
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
        '/ipfs': {
          target: 'https://tomato-rational-rat-921.mypinata.cloud',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/ipfs/, '/ipfs')
        },
        ...(apiProxyTarget
          ? {
              '/api': {
                target: apiProxyTarget,
                changeOrigin: true,
                rewrite: path =>
                  apiProxyProvider === 'netlify'
                    ? path.replace(/^\/api\/pinata\/upload$/, '/.netlify/functions/pinata-upload')
                    : path
              }
            }
          : {})
      }
    },
    optimizeDeps: {
      // Evitamos prebundling de WASM del core de la billetera.
      exclude: ['minimal-xec-wallet'],
      include: ['buffer'],
      esbuildOptions: {
        define: {
          global: 'globalThis'
        }
      }
    },
    build: {
      target: 'esnext'
    }
  }
})
