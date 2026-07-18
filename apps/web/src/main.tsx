import "@fontsource-variable/inter";
import "@fontsource/geist-mono";
import "katex/dist/katex.min.css";
import "./styles/globals.css";

import { createRoot } from "react-dom/client";
import App from "./App";

// NO StrictMode on purpose: the editor mount effect creates the collab session
// (Y.Doc + WebsocketProvider + CodeMirror mount); StrictMode's double-invoked
// effects would create duplicate providers/undo managers (see migration plan —
// same mount-discipline rule as apps/desktop).
createRoot(document.getElementById("root")!).render(<App />);
