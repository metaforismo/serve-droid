import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DeviceWheelInput } from "./DeviceWheelInput.js";
import { LivePointerInput } from "./LivePointerInput.js";
import { ScreenshotCapture } from "./ScreenshotCapture.js";
import "./styles.css";
import "./cockpit-v2.css";
import "./cockpit-motion.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <LivePointerInput />
    <DeviceWheelInput />
    <ScreenshotCapture />
  </StrictMode>,
);
