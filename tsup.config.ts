import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "node20",
    shims: true,
  },
  {
    entry: {
      action: "src/action.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node20",
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
