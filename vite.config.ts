import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const webOdmTarget = env.VITE_WEBODM_URL || 'http://localhost:8000'

  return {
    plugins: [react()],
    server: {
      hmr: {
        overlay: true,
      },
      proxy: {
        '/webodm': {
          target: webOdmTarget,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/webodm/, ''),
        },
        '/api': {
          target: 'http://localhost:5000',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})
