import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: [
      "sdks/typescript/*/test/**/*.test.ts",
      "services/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    testTimeout: 20_000,
  },
});
