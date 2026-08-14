import esbuild from "esbuild";

// Release builds ship no sourcemap: an inline map embeds the full TypeScript source
// into main.js, which bloats every user's download. Dev builds keep it.
const isProduction = process.argv.includes("production");

const context = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2020",
  outfile: "main.js",
  sourcemap: isProduction ? false : "inline",
  // Deliberately not minified. Obsidian's developer policy prohibits obfuscated
  // code, and reviewers read the shipped main.js — readable output keeps the
  // published bundle trivially auditable against this repository.
  minify: false,
  logLevel: "info",
};

if (process.argv.includes("watch")) {
  const ctx = await esbuild.context(context);
  await ctx.watch();
} else {
  await esbuild.build(context);
}
