import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  // No source maps: keeps the published tarball lean and avoids shipping maps that
  // dangle to an unpublished src/. (Re-enable by setting true + adding "src" to files.)
  sourcemap: false,
  clean: true,
  treeshake: true,
  target: "es2022",
  // Keep the heavy @ton/* + the sibling SDK external — consumers install them.
  external: ["@ton/core", "@ton/crypto", "@ton/ton", "@mystars-tg/faas-sdk"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
