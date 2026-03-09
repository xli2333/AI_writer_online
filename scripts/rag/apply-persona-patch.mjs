import fs from "node:fs/promises";
import path from "node:path";
import { GLOBAL_DIR, RAG_DIR, ensureDir, initRagDirs, readUtf8, writeUtf8 } from "./shared.mjs";

const REPORT_DIR = path.join(RAG_DIR, "evals", "reports");
const PERSONA_DIR = path.join(RAG_DIR, "persona");
const MASTER_PERSONA_PATH = path.join(GLOBAL_DIR, "runtime", "master_persona.md");
const LATEST_PATCH_PATH = path.join(PERSONA_DIR, "latest_patch.md");
const PATCH_LEDGER_PATH = path.join(PERSONA_DIR, "persona_patches.jsonl");
const HISTORY_DIR = path.join(GLOBAL_DIR, "runtime", "history");

async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function main() {
  await initRagDirs();
  await ensureDir(HISTORY_DIR);

  const latestReport = JSON.parse(await readUtf8(path.join(REPORT_DIR, "latest.json")));
  if (!latestReport.pass) {
    console.log("latest eval did not pass; skip applying patch");
    return;
  }

  const previousPersona = await readUtf8(MASTER_PERSONA_PATH);
  const nextPersona = await readUtf8(LATEST_PATCH_PATH);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (previousPersona.trim()) {
    await writeUtf8(path.join(HISTORY_DIR, `master_persona.applied.${stamp}.before.md`), `${previousPersona.trim()}\n`);
  }

  await writeUtf8(MASTER_PERSONA_PATH, `${nextPersona.trim()}\n`);
  await appendJsonl(PATCH_LEDGER_PATH, {
    applied_at: new Date().toISOString(),
    patch_win_rate: latestReport.patch_win_rate,
    summary: latestReport.summary,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
