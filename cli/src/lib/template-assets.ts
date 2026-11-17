import { fileURLToPath } from "node:url";

const bundled = import.meta.url.endsWith(".js");
export const TEMPLATES_DIR = fileURLToPath(
  new URL(bundled ? "../template/" : "../../../template/", import.meta.url),
);
