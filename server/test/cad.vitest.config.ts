import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Execute the changed contract sources without a full shared/server build.
export default defineConfig({
  resolve: { alias: { "@libiaolink/contracts": fileURLToPath(new URL("../../shared/src/index.ts", import.meta.url)) } },
  test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 180_000, hookTimeout: 180_000 },
});
