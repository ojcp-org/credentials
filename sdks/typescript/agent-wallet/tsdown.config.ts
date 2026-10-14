import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp.ts"],
  format: "esm",
  dts: false,
  platform: "neutral",
  external: [/^@modelcontextprotocol\//],
});
