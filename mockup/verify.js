/* Headless verification v2 — render + interaction smoke test + screenshots. */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FILE = "file://" + path.resolve(__dirname, "index.html");
const SHOTS = path.resolve(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const consoleErrors = [], pageErrors = [], external = [], failed = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", e => pageErrors.push(e.message));
  page.on("request", r => { const u = r.url(); if (!/^(file:|data:|blob:|about:)/.test(u)) external.push(u); });
  const wait = ms => page.waitForTimeout(ms);
  const shot = n => page.screenshot({ path: path.join(SHOTS, n + ".png") });
  const click = async sel => { await page.click(sel); await wait(120); };
  const ev = fn => page.evaluate(fn);
  const step = async (name, fn) => { try { await fn(); process.stdout.write("  ok  " + name + "\n"); } catch (e) { failed.push(name); process.stdout.write("  XX  " + name + " -- " + e.message.split("\n")[0] + "\n"); } };

  await page.goto(FILE, { waitUntil: "domcontentloaded" });
  await wait(250);

  await step("login", async () => { await page.waitForSelector('[data-act="demoLogin"]'); await shot("01-login"); });
  await step("sign in → dashboard (map+table)", async () => { await click('[data-act="demoLogin"][data-uid="u_manager"]'); await page.waitForSelector("table.tbl"); await page.waitForSelector(".map svg"); await shot("02-dashboard"); });
  await step("open new search wizard", async () => { await click('[data-act="newBatch"]'); await page.waitForSelector("#wz-name"); await shot("03-wizard-step1"); });
  await step("step1 name + Next", async () => { await page.fill("#wz-name", "SH-130 Corridor Recruitment"); await page.fill('[data-model="wizard.customer"]', "Central TX Materials"); await click('[data-act="wzStep"][data-s="2"]'); await page.waitForSelector('[data-act="wzAddLane"]'); });
  await step("add radius lane", async () => { await click('[data-act="wzAddLane"][data-t="radius"]'); await page.waitForSelector('[data-act="wzSaveLane"]'); await click('[data-act="wzSaveLane"]'); if (!(await page.$(".lane"))) throw new Error("lane not added"); });
  await step("add corridor lane (multi-lane)", async () => { await click('[data-act="wzAddLane"][data-t="corridor"]'); await page.waitForSelector('[data-act="wzSaveLane"]'); await click('[data-act="wzSaveLane"]'); const n = await page.$$eval(".lane", e => e.length); if (n < 2) throw new Error("expected 2 lanes, got " + n); await shot("04-wizard-lanes"); });
  await step("step3 freight facets", async () => {
    await click('[data-act="wzStep"][data-s="3"]'); await page.waitForSelector(".cargo-flags");
    await ev(() => ACT.wzFlag({ f: "Construction" }));
    if (!(await page.$(".facet-row"))) throw new Error("no facet rows");
    await ev(() => { const b = document.querySelector('[data-act="wzOther"][data-m="exc"]'); ACT.wzOther({ v: b.getAttribute("data-v"), m: "exc" }); });
    await shot("05-wizard-freight");
  });
  await step("step4 filters + grab", async () => {
    await click('[data-act="wzStep"][data-s="4"]'); await page.waitForSelector('[data-act="wzGrab"]');
    await ev(() => ACT.wzFilter({ k: "hasPhone", value: true }));
    await shot("06-wizard-filters");
    await click('[data-act="wzGrab"]'); await page.waitForSelector("#wl-body table.tbl");
  });
  await step("working list (activity, warnings, contact cols)", async () => {
    await page.waitForSelector(".feed"); await page.waitForSelector(".strip");
    if (!(await page.$("tr.warn-row"))) throw new Error("no warning rows visible");
    await shot("07-working-list");
  });
  await step("existing batch via dashboard", async () => { await ev(() => ACT.nav({ to: "dashboard" })); await wait(80); await ev(() => ACT.openBatch({ id: "b_waco" })); await wait(120); await shot("08-batch-waco-multilane"); });
  await step("warnings-only filter", async () => { await click('[data-act="listWarnings"]'); await shot("09-warnings-only"); await click('[data-act="listWarnings"]'); });
  await step("map view (numbered pins)", async () => { await click('[data-act="listView"][data-v="map"]'); await page.waitForSelector(".map svg .pin"); await shot("10-batch-map"); await click('[data-act="listView"][data-v="list"]'); });
  await step("row status change", async () => { const r = await ev(() => { const s = document.querySelector('select[data-change="rowStatus"]'); return s ? { dot: s.getAttribute("data-dot"), batch: s.getAttribute("data-batch") } : null; }); if (r) await page.evaluate(r => ACT.rowStatus({ dot: r.dot, batch: r.batch, value: "contacted" }), r); });
  await step("log outreach (multi-channel)", async () => {
    const r = await ev(() => { const b = document.querySelector('[data-act="logCall"]'); return b ? { dot: b.getAttribute("data-dot"), batch: b.getAttribute("data-batch") } : null; });
    await page.evaluate(r => ACT.logCall({ dot: r.dot, batch: r.batch }), r); await page.waitForSelector(".modal .seg");
    await ev(() => { const b = document.querySelector('[data-act="logChannel"][data-channel="text"]'); ACT.logChannel({ dot: b.getAttribute("data-dot"), batch: b.getAttribute("data-batch"), channel: "text" }); });
    await shot("11-log-modal"); await ev(() => ACT.submitLogBtn()); await wait(120);
  });
  await step("select all → contact sheet (name+email)", async () => {
    await ev(() => ACT.selAll({ value: true })); await wait(150); await shot("12-bulk-bar");
    await click('[data-act="genContact"]'); await page.waitForSelector(".modal.lg"); await shot("13-contact-sheet");
    await ev(() => { const b = document.querySelector('[data-act="exportSheet"]'); ACT.exportSheet({ kind: b.getAttribute("data-kind"), batch: b.getAttribute("data-batch") }); });
    await ev(() => { state.modal = null; render(); }); await ev(() => ACT.clearSel());
  });
  await step("open carrier → profile (console)", async () => { await ev(() => { const tr = document.querySelector("tr[data-act='openCarrier']"); ACT.openCarrier({ dot: tr.getAttribute("data-dot"), from: tr.getAttribute("data-from") }); }); await page.waitForSelector('[data-act="profVariant"]'); await shot("14-profile-console"); });
  await step("profile variant: dossier", async () => { await click('[data-act="profVariant"][data-v="dossier"]'); await page.waitForSelector(".dossier-head"); await shot("15-profile-dossier"); });
  await step("profile variant: ledger", async () => { await click('[data-act="profVariant"][data-v="ledger"]'); await page.waitForSelector(".ledger-row"); await shot("16-profile-ledger"); });
  await step("promote modal", async () => { await ev(() => { const b = document.querySelector('[data-act="promote"]'); if (b) ACT.promote({ dot: b.getAttribute("data-dot") }); }); await page.waitForSelector(".modal"); await shot("17-promote"); await ev(() => { state.modal = null; render(); }); });
  await step("global DNC modal", async () => { await ev(() => { const el = document.querySelector('[data-act="toggleDnc"]'); ACT.toggleDnc({ dot: el.getAttribute("data-dot") }); }); await page.waitForSelector(".modal"); await shot("18-dnc"); await ev(() => { state.modal = null; render(); }); });
  await step("users admin + approve", async () => { await ev(() => ACT.nav({ to: "users" })); await page.waitForSelector('[data-act="approveUser"]'); await click('[data-act="approveUser"]'); await page.waitForSelector(".modal"); await shot("19-users-approve"); await ev(() => { state.modal = null; render(); }); });
  await step("reserved tab toast (F2)", async () => { await ev(() => ACT.nav({ to: "dashboard" })); await ev(() => ACT.reservedTab({ label: "Email Blasts" })); await wait(150); if (!(await page.$(".toast"))) throw new Error("no toast"); });
  await step("dark theme", async () => { await ev(() => ACT.toggleTheme()); await wait(120); await shot("20-dashboard-dark"); });
  await step("guest gate", async () => { await ev(() => ACT.toggleTheme()); await ev(() => ACT.logout()); await page.waitForSelector('[data-act="demoLogin"]'); await ev(() => ACT.demoLogin({ uid: "u_guest1" })); await wait(120); if (await page.$('[data-act="openBatch"]')) throw new Error("guest saw batches"); await shot("21-guest"); });

  await browser.close();
  process.stdout.write("\nconsole.errors: " + consoleErrors.length + "\n"); consoleErrors.slice(0,15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("pageerrors: " + pageErrors.length + "\n"); pageErrors.slice(0,15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("external requests: " + external.length + "\n"); external.slice(0,15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("failed steps: " + failed.length + "\n");
  process.stdout.write("\nRESULT: " + (failed.length || consoleErrors.length || pageErrors.length || external.length ? "ISSUES" : "ALL CLEAR") + "\n");
})().catch(e => { process.stdout.write("FATAL " + e.message + "\n"); process.exit(1); });
