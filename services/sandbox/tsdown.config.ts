import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  dts: false,
  platform: "node",
});
