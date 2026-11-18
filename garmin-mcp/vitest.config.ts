import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { GARMIN_API_KEY: "test-api-key", ACCESS_AUD: "local-dev" },
      },
    }),
  ],
});
