import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const require = createRequire(import.meta.url);
const bundle = await rolldown({ input: require.resolve("web-push"), platform: "node" });
try {
  await bundle.write({
    file: fileURLToPath(new URL("./dist/server-web-push.cjs", import.meta.url)),
    format: "cjs",
    minify: true,
  });
} finally { await bundle.close(); }
