import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// \`npm run build\`          => normal multi-file build for hosting / Capacitor (dist/)
// \`npm run build:preview\`  => one self-contained HTML file for sharing a demo (dist-preview/)
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'singlefile' ? [viteSingleFile()] : [])],
  build: mode === 'singlefile' ? { outDir: 'dist-preview' } : { outDir: 'dist' },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision']
  }
}));
