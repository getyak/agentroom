import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Friends } from "./Friends";

createRoot(document.getElementById("root")!).render(<StrictMode><Friends browser /></StrictMode>);
