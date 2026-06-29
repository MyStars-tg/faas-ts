import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm", "cjs"],
  dts: { entry: "src/index.ts" },
  // No source maps: keeps the published tarball lean and avoids shipping maps that
  // dangle to an unpublished src/. (Re-enable by setting true + adding "src" to files.)
  sourcemap: false,
  clean: true,
  target: "es2022",
  external: ["@mystars-tg/faas-sdk", "commander"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
