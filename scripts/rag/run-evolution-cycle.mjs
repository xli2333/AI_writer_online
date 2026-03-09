import { spawn } from "node:child_process";

const forwardedArgs = process.argv.slice(2);
const steps = [
  ["node", ["scripts/rag/build-rule-cards.mjs", ...forwardedArgs]],
  ["node", ["scripts/rag/build-persona-patches.mjs", ...forwardedArgs]],
  ["node", ["scripts/rag/evaluate-persona.mjs", ...forwardedArgs]],
  ["node", ["scripts/rag/apply-persona-patch.mjs", ...forwardedArgs]],
];

function runStep(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Step failed: ${command} ${args.join(" ")} (exit ${code})`));
    });
  });
}

async function main() {
  for (const [command, args] of steps) {
    await runStep(command, args);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
