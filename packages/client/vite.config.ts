import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        // m4a included deliberately: the weapon samples are part of the offline
        // guarantee, and a PWA that installs without them plays a silent match.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2,m4a}'],
        // The whole game must run offline; Phaser chunks are large.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'Aerocade',
        short_name: 'Aerocade',
        description:
          'Original fast-paced 2D jetpack arena shooter. LAN multiplayer, no internet needed.',
        start_url: '.',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#0b1020',
        theme_color: '#0b1020',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', sourcemap: true },
});
