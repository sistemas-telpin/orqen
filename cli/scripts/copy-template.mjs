import { cpSync, mkdirSync, rmSync } from "node:fs";

const source = new URL("../../template/", import.meta.url);
const destination = new URL("../dist/template/", import.meta.url);

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const path of ["AGENTS.md", ".agents", "env.example", "openspec", "orqen", "stages"]) {
  cpSync(new URL(path, source), new URL(path, destination), { recursive: true });
}

// Stack catalog for `orqen create project`.
const tools = new URL("../../tools/", import.meta.url);
const toolsDestination = new URL("../dist/tools/", import.meta.url);
rmSync(toolsDestination, { recursive: true, force: true });
cpSync(tools, toolsDestination, { recursive: true });
