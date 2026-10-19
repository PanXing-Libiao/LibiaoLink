import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SystemTooltip } from "./components/SystemTooltip";
import "./app.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("页面缺少 #root 容器");
}

createRoot(container).render(
  <StrictMode>
    <SystemTooltip />
    <App />
  </StrictMode>,
);
