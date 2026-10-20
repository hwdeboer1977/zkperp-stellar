import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { WalletProvider } from "./lib/wallet";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <App />
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
);
