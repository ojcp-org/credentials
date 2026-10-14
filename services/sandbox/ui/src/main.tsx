import "@mantine/core/styles.css";
import "./global.css";
import { MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot } from "./boot.ts";
import { SandboxBar } from "./chrome/SandboxBar.tsx";
import { Assistant } from "./personas/Assistant.tsx";
import { Employer } from "./personas/Employer.tsx";
import { Hood } from "./personas/Hood.tsx";
import { Hr } from "./personas/Hr.tsx";
import { Registry } from "./personas/Registry.tsx";
import { Wallet } from "./personas/Wallet.tsx";
import { themeFor } from "./theme.ts";

function Persona() {
  switch (boot.role) {
    case "hr":
      return <Hr />;
    case "wallet":
      return <Wallet />;
    case "agent":
      return <Assistant />;
    case "home":
      return <Hood />;
    case "attestA":
    case "attestB":
    case "lists":
      return <Registry />;
    default:
      return <Employer />;
  }
}

const { theme, scheme } = themeFor(boot.role);
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <MantineProvider theme={theme} forceColorScheme={scheme}>
        <SandboxBar />
        <Persona />
      </MantineProvider>
    </StrictMode>,
  );
