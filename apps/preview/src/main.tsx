import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@adw/ui/styles.css";
import "./preview.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
