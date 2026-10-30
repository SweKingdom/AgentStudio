// A tiny lint step with no dependencies: no console.log in src/ (except the server's start line) and no TODO left
// in src/. Exits 1 with the file and line of each problem.
import fs from "node:fs";
import path from "node:path";

const problems = [];
for (const file of fs.readdirSync("src")) {
  if (!file.endsWith(".js")) continue;
  const lines = fs.readFileSync(path.join("src", file), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/\bTODO\b/.test(line)) problems.push(`src/${file}:${i + 1}: TODO left in the code`);
    if (/console\.log\(/.test(line) && !/Task tracker on/.test(line)) problems.push(`src/${file}:${i + 1}: console.log in src/`);
  });
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("lint: ok");
