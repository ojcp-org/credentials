import "@mantine/core/styles.css";
import "./global.css";
import { MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot } from "./boot.ts";
import { Narrator } from "./chrome/Narrator.tsx";
import { SandboxBar } from "./chrome/SandboxBar.tsx";
import { Assistant } from "./personas/Assistant.tsx";
import { Employer } from "./personas/Employer.tsx";
import { Hood } from "./personas/Hood.tsx";
import { Hr } from "./personas/Hr.tsx";
import { Registry } from "./personas/Registry.tsx";
import { Wallet } from "./personas/Wallet.tsx";
import { Welcome } from "./personas/Welcome.tsx";
import { themeFor } from "./theme.ts";

function Persona() {
  switch (boot.role) {
    case "hr":
    case "mdp":
    case "vandelay":
      return <Hr />;
    case "wallet":
      return <Wallet />;
    case "agent":
      return <Assistant />;
    case "home":
      return location.pathname === "/hood" ? <Hood /> : <Welcome />;
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
// The wallet app opens a session for its owner on this device before anything else.
const ready = boot.role === "wallet" ? fetch("/_session").then(() => undefined) : Promise.resolve();
if (root)
  void ready.then(() =>
    createRoot(root).render(
      <StrictMode>
        <MantineProvider theme={theme} forceColorScheme={scheme}>
          <SandboxBar />
          <Persona />
          <Narrator />
        </MantineProvider>
      </StrictMode>,
    ),
  );
