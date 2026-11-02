import React from "react";
import { createRoot } from "react-dom/client";
import { MobileClientDemo } from "./MobileClientDemo";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MobileClientDemo />
  </React.StrictMode>
);
