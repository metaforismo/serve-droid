import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ScreenshotCapture } from "./ScreenshotCapture.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <ScreenshotCapture />
  </StrictMode>,
);
