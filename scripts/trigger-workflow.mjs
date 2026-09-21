// Pokreće GitHub Actions workflow "Update bingo results" direktno sa lokala.
// Token ne čita iz environment-a nego iz Windows Git Credential Manager-a (isto mesto
// odakle `git push` crpi kredencijale), pa ne moraš ništa dodatno da konfigurišeš.
//
// Pokretanje:
//   npm run trigger              # pokrene workflow i izlazi
//   npm run trigger -- --wait    # pokrene workflow i sačeka kraj (ispisuje status)
//
// Repo se detektuje automatski iz `git remote get-url origin` — bez hardkodovanja.
// Transport: curl (pouzdan na svim mašinama; node fetch ume da zagusti na nekim mrežama).

import { execSync, execFileSync } from "node:child_process";
import process from "node:process";

const OWNER_REPO = getOwnerRepo();
const API = `https://api.github.com/repos/${OWNER_REPO}`;

function getOwnerRepo() {
  try {
    const url = execSync("git remote get-url origin", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {
    /* ne git repo? */
  }
  // fallback — ako neko skriptu koristi van repoa
  return "dexilio13-ui/wingo";
}

/** Uzme token iz Git Credential Manager-a (isti izvor koji koristi git push). */
function getToken() {
  const out = execSync(
    'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill',
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
  const line = out.split("\n").find((l) => l.startsWith("password="));
  if (!line) throw new Error("Nema sačuvanog GitHub tokena — pokreni git push jednom ručno da se sačuva.");
  return line.slice(9).trim();
}

/** HTTP preko curl-a; vraća { status, body }. execFileSync = bez shell-a, argumenti idu netaknuti. */
function curl({ method = "GET", url, token, body }) {
  const args = [
    "-s", "-L",
    "--connect-timeout", "10",
    "--max-time", "30",
    "-X", method,
    "-H", `Authorization: token ${token}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "User-Agent: bingo-trigger",
    "-w", "\n%{http_code}",
  ];
  if (body) args.push("-d", body, "-H", "Content-Type: application/json");
  args.push(url);
  const out = execFileSync("curl", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const idx = out.lastIndexOf("\n");
  return { status: Number(out.slice(idx + 1).trim()), body: out.slice(0, idx) };
}

async function main() {
  const wait = process.argv.includes("--wait");
  const token = getToken();

  // 1) pokreni workflow
  let res;
  try {
    res = curl({
      method: "POST",
      url: `${API}/actions/workflows/update-bingo.yml/dispatches`,
      token,
      body: JSON.stringify({ ref: "main", inputs: { quick: true } }),
    });
  } catch (e) {
    console.error(`❌ curl ne radi: ${e.message.slice(0, 200)}`);
    process.exit(1);
  }
  if (res.status === 204) {
    console.log(`✅ Workflow pokrenut na ${OWNER_REPO} (main)`);
  } else {
    console.error(`❌ Dispatch nije prošao: HTTP ${res.status}\n${res.body.slice(0, 300)}`);
    process.exit(1);
  }

  if (!wait) return;

  // 2) čekaj kraj najnovijeg run-a
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(4000); // run se registruje sa malim zakašnjenjem
  for (let i = 0; i < 30; i++) {
    try {
      const runsRes = curl({ url: `${API}/actions/runs?per_page=1`, token });
      const run = JSON.parse(runsRes.body).workflow_runs?.[0];
      if (run) {
        process.stdout.write(`\r run: ${run.status} (${run.conclusion ?? "…"})   `);
        if (run.status === "completed") {
          console.log(`\n${run.conclusion === "success" ? "✅" : "❌"} Završeno: ${run.conclusion}`);
          process.exit(run.conclusion === "success" ? 0 : 1);
        }
      }
    } catch { /* privremena greška — probaj opet */ }
    await sleep(5000);
  }
  console.log("\n⏳ Timeout čekanja (workflow i dalje radi na GitHub-u)");
}

main().catch((e) => {
  console.error("GREŠKA:", e.message);
  process.exit(1);
});
