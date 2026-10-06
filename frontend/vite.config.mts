import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { fleetGuardPlugin, fleetProxy, fleetTarget } from './dev/fleet-proxy.mts'

const root = fileURLToPath(new URL('.', import.meta.url))
// The Fleet server to develop against (FLEET_PORT), and Vite's own port.
const fleetPort = Number(process.env.FLEET_PORT || 7777)
const devPort = Number(process.env.FLEET_DEV_PORT || 5173)

export default defineConfig({
  root,
  base: '/',
  publicDir: 'public',
  plugins: [react(), fleetGuardPlugin(devPort)],
  build: {
    // Generated only; never hand-edited. server.js serves it from cutover on.
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
    emptyOutDir: true,
    manifest: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
    // Fleet answers no cross-origin requests; neither does its dev server.
    cors: false,
    proxy: fleetProxy(fleetTarget(fleetPort)),
  },
  test: {
    root,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'dev/**/*.test.mts'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
    // CI runners are several times slower than a laptop; whole-shell tests that load
    // lazy feature chunks need room beyond the 5s default.
    testTimeout: 20000,
  },
})
