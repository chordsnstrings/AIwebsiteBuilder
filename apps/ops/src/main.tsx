import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// ⛔ The console has its own stylesheet and does NOT import @adw/ui. The shared
// kit is a product design system — rounded cards, drop shadows, a marketing
// blue — and an operator console is a different instrument. It is also no
// longer a dependency of this app at all, which is the point: the demo-data
// fixtures it used to render cannot be imported from here even by accident.
import "./console.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
