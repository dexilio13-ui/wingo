// Minimalni statički server za viewer (nula zavisnosti).
// Pokretanje: npm run serve  →  http://localhost:8080
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);

    // GET /trigger → pokreni GitHub Actions workflow (fetch-bingo) sa ovog računara.
    // Koristi se iz viewer-a: dugme „↻ Osveži” ga zove u pozadini.
    if (pathname === "/trigger") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, hint: "workflow pokrenut" }));
      import("node:child_process").then(({ spawn }) => {
        const child = spawn(process.execPath, [path.join(ROOT, "scripts", "trigger-workflow.mjs")], {
          cwd: ROOT,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      });
      return;
    }

    if (pathname === "/") pathname = "/index.html";
    const file = path.join(ROOT, path.normalize(pathname));
    if (!file.startsWith(path.normalize(ROOT))) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("404 — nije nađeno: " + pathname);
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`Viewer radi: http://localhost:${PORT}`));
