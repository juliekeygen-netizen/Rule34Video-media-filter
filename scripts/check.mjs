import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "tests"];
const extensions = new Set([".js", ".mjs", ".cjs"]);
const files = [];

function walk(path) {
  for (const name of readdirSync(path)) {
    const fullPath = join(path, name);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (extensions.has(extname(name))) {
      files.push(fullPath);
    }
  }
}

for (const root of roots) {
  walk(root);
}

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`\nSyntax check failed: ${file}\n`);
    process.stderr.write(result.stderr || result.stdout || "Unknown syntax error\n");
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
