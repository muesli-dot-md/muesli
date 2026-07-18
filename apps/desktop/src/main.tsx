import "@fontsource-variable/inter";
import "@fontsource/geist-mono";
import "katex/dist/katex.min.css";
import "./styles/globals.css";

import { createRoot } from "react-dom/client";
import App from "./App";

// NO StrictMode on purpose: the editor mount effect attaches Tauri IPC
// sessions (attach_editor + frame listeners); StrictMode's double-invoked
// effects would create duplicate sessions/frames (see migration plan).
createRoot(document.getElementById("root")!).render(<App />);
