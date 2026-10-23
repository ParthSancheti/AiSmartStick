import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// \`npm run build\`          => normal multi-file build for hosting / Capacitor (dist/)
// \`npm run build:preview\`  => one self-contained HTML file for sharing a demo (dist-preview/)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const role = env.VITE_APP_ROLE || 'user';
  if (!['user', 'guardian', 'combined'].includes(role)) throw new Error('VITE_APP_ROLE must be user, guardian or combined');
  return ({
  plugins: [react(), tailwindcss(), {
    name: 'aiss-build-role',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-role.json', source: JSON.stringify({ role, mode: env.VITE_APP_MODE || 'real' }) });
    },
  }, ...(mode === 'singlefile' ? [viteSingleFile()] : [])],
  build: mode === 'singlefile' ? { outDir: 'dist-preview' } : { outDir: 'dist' },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision']
  }
});
});
