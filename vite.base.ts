// Shared Vite config for the ADW frontend apps. Route-level code splitting,
// vendor chunk separation and an esbuild target tuned for modern browsers keep
// the apps fast (Lighthouse Performance >= 85).
import react from "@vitejs/plugin-react";
import type { UserConfig } from "vite";

export function baseConfig(root: string, port: number): UserConfig {
  return {
    root,
    plugins: [react()],
    server: { port, host: true },
    preview: { port, host: true },
    build: {
      target: "es2022",
      cssMinify: true,
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes("node_modules/react")) return "react";
            if (id.includes("node_modules/react-router")) return "router";
            return undefined;
          },
        },
      },
    },
  };
}
