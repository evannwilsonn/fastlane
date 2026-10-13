import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run build` emits the page to dist/.
// `SINGLE=1 npm run build` emits one self-contained HTML file to dist-single/.
const single = Boolean(process.env.SINGLE);

export default defineConfig({
  base: "./",
  plugins: single ? [viteSingleFile()] : [],
  build: { outDir: single ? "dist-single" : "dist" },
});
