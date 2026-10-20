import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The backend services (circuits/services, run by pm2) are proxied under /svc,
// so the browser talks to them same-origin, as zkperp-midnight's frontend does.
const svc = (prefix: string, port: number) => ({
  [prefix]: { target: `http://127.0.0.1:${port}`, rewrite: (p: string) => p.replace(new RegExp(`^${prefix}`), "") },
});

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ["buffer", "process", "util", "stream", "events", "crypto", "path", "os", "url", "assert"] })],
  resolve: {
    alias: {
      // The one copy of the ZK code (circuits/lib), shared with the CLI and services.
      "@zk": path.resolve(__dirname, "../circuits/lib"),
      // The polyfill plugin injects these shims into modules that use Buffer or
      // process, including ../circuits/lib (outside this package): resolve
      // them from here.
      "vite-plugin-node-polyfills/shims/buffer": path.resolve(__dirname, "node_modules/vite-plugin-node-polyfills/shims/buffer/dist/index.js"),
      "vite-plugin-node-polyfills/shims/process": path.resolve(__dirname, "node_modules/vite-plugin-node-polyfills/shims/process/dist/index.js"),
      "vite-plugin-node-polyfills/shims/global": path.resolve(__dirname, "node_modules/vite-plugin-node-polyfills/shims/global/dist/index.js"),
    },
    // ../circuits/lib imports these: resolve them from this package's
    // node_modules (one copy, polyfilled for the browser), not ../circuits'.
    dedupe: ["snarkjs", "circomlibjs", "@stellar/stellar-sdk", "ffjavascript"],
  },
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
  server: {
    port: 5174,
    host: true, // reachable from the Windows browser under WSL2
    fs: { allow: [".", "../circuits"] },
    proxy: {
      ...svc("/svc/relay", 3030),
      ...svc("/svc/oracle/1", 3020),
      ...svc("/svc/oracle/2", 3021),
      ...svc("/svc/oracle/3", 3022),
      ...svc("/svc/keeper/1", 3041),
      ...svc("/svc/keeper/2", 3042),
      ...svc("/svc/keeper/3", 3043),
    },
  },
});
