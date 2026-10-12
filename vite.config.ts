import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: ["index.html"], include: ["exceljs", "fflate"] },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          validation: ["zod"],
          storage: ["dexie"],
          react: ["react", "react-dom"],
          precision: ["decimal.js"],
        },
      },
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
