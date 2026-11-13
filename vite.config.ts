import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
export default defineConfig({ define: { __BUILD__: JSON.stringify(Date.now()) }, base: './', plugins: [preact()], build: { target: 'es2020' } });
