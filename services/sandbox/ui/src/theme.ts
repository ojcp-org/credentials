/**
 * ojcp.dev's theme (src/theme/index.ts in ojcp-website): gold and blue on
 * obsidian, JetBrains Mono. The sandbox chrome and "Under the hood" use it as
 * is. Each party's own site keeps its own look, so it's always clear whose
 * screen you're on.
 */
import { createTheme, type MantineColorsTuple, type MantineThemeOverride } from "@mantine/core";
import type { Role } from "./boot.ts";

const ojcpGold: MantineColorsTuple = [
  "#fdf5e5",
  "#f6e4b8",
  "#f0d08a",
  "#e8a830",
  "#d49520",
  "#b87e1a",
  "#9c6815",
  "#805210",
  "#643e0c",
  "#4a2c08",
];

const ojcpBlue: MantineColorsTuple = [
  "#e8f2fb",
  "#c8ddf2",
  "#9ec4e6",
  "#5b9fd4",
  "#3d80b8",
  "#2e6a9e",
  "#245684",
  "#1b436a",
  "#133252",
  "#0c223a",
];

const dark: MantineColorsTuple = [
  "#ececf0",
  "#b8b8c4",
  "#9090a0",
  "#6b6b78",
  "#3a3a46",
  "#28282f",
  "#1e1e26",
  "#18181e",
  "#111116",
  "#0c0c0f",
];

export const OJCP = {
  gold: "#e8a830",
  obsidian: "#0c0c0f",
  surface: "#18181e",
  elevated: "#1e1e26",
  text: "#ececf0",
  muted: "#9090a0",
  mono: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
  sans: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

const base: MantineThemeOverride = {
  colors: { ojcpGold, ojcpBlue, dark },
  defaultRadius: "md",
  fontFamily: OJCP.sans,
  fontFamilyMonospace: OJCP.mono,
  headings: { fontFamily: OJCP.sans, fontWeight: "650" },
};

/** The OJCP look, exactly as on ojcp.dev. */
const ojcp = createTheme({
  ...base,
  primaryColor: "ojcpGold",
  primaryShade: 3,
  fontFamily: `'JetBrains Mono', ${OJCP.sans}`,
  headings: { fontFamily: OJCP.mono, fontWeight: "700" },
  defaultRadius: "sm",
});

export function themeFor(role: Role): { theme: MantineThemeOverride; scheme: "light" | "dark" } {
  switch (role) {
    case "home":
      return { theme: ojcp, scheme: "dark" };
    case "hr":
      return { theme: createTheme({ ...base, primaryColor: "teal" }), scheme: "light" };
    case "wallet":
      return { theme: createTheme({ ...base, primaryColor: "indigo" }), scheme: "light" };
    case "agent":
      return {
        theme: createTheme({ ...base, primaryColor: "dark", primaryShade: 7 }),
        scheme: "light",
      };
    case "attestA":
    case "attestB":
    case "lists":
      return { theme: createTheme({ ...base, primaryColor: "green" }), scheme: "light" };
    default:
      return { theme: createTheme({ ...base, primaryColor: "orange" }), scheme: "light" };
  }
}
