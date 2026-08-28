// Shared plumbing for the browser verification scripts: locating Playwright and
// a Chromium binary without making either a dependency of this project.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

const CHROMIUM_GLOBS = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
];

export async function launchBrowser() {
  const modulePath =
    process.env.PLAYWRIGHT_MODULE ??
    tryResolve("playwright") ??
    tryResolve("playwright-core");

  if (!modulePath) {
    throw new Error(
      "Playwright not found. Install it globally (npm i -g playwright) or set PLAYWRIGHT_MODULE.",
    );
  }

  const mod = require(modulePath);
  const chromium = mod.chromium ?? mod.default?.chromium;

  const { existsSync } = await import("node:fs");
  const executablePath = CHROMIUM_GLOBS.find((p) => p && existsSync(p));

  // With no explicit path, let Playwright use whatever browser it manages.
  return chromium.launch(executablePath ? { executablePath } : {});
}

function tryResolve(name) {
  try {
    return require.resolve(name);
  } catch {
    for (const root of ["/opt/node22/lib/node_modules", "/usr/lib/node_modules"]) {
      try {
        return require.resolve(`${root}/${name}`);
      } catch {
        // Keep looking.
      }
    }
    return null;
  }
}

export function makeChecker() {
  const results = [];
  const check = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, pass });
    const detail = pass ? "" : `  got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail}`);
  };
  const finish = () => {
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    return failed;
  };
  return { check, finish };
}

/** Read the most recently updated canvas out of the app's IndexedDB. */
export async function readPersistedCanvas(page) {
  return page.evaluate(async () => {
    const req = indexedDB.open("MindMapDB");
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!db.objectStoreNames.contains("canvases")) return null;
    const all = await new Promise((resolve, reject) => {
      const r = db.transaction("canvases").objectStore("canvases").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    all.sort((a, b) => b.updated.localeCompare(a.updated));
    return all[0]?.doc ?? null;
  });
}
