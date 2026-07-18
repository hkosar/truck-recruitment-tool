/* Headless verification v3 — render + interaction smoke test + screenshots. */
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

  await step("login (no subtext)", async () => { await page.waitForSelector('[data-act="demoLogin"]'); await shot("01-login"); });
  await step("dashboard: empty map + toggles + stage columns", async () => {
    await click('[data-act="demoLogin"][data-uid="u_manager"]'); await page.waitForSelector("table.tbl");
    if (!(await page.$(".map-empty"))) throw new Error("map should start empty (F30)");
    if (await page.$(".pipebar")) throw new Error("pipeline bar should be gone (F31)");
    const heads = await page.$$eval("table.tbl thead th", els => els.map(e => e.textContent.trim()));
    if (!heads.some(h => /New/.test(h)) || !heads.some(h => /Int/.test(h))) throw new Error("stage columns missing: " + heads.join("|"));
    // F39/F41: one thought per line
    const spans = await page.$eval(".co.oneline", e => e.querySelectorAll("span").length);
    if (spans < 3) throw new Error("batch cell should have 3 lines, got " + spans);
    if (!(await page.$(".lanes-cell div"))) throw new Error("lanes not one-per-line");
    await shot("02-dashboard-empty");
  });
  await step("dashboard: toggle job → zones + zoom", async () => {
    await click('[data-act="dashToggleJob"]'); await wait(150);
    if (!(await page.$(".radius-fill, .corridor-band"))) throw new Error("no zones after toggle");
    const vb = await page.$eval('.map[data-mapid="dash"] svg', s => s.getAttribute("viewBox"));
    if (vb === "0 0 640 520") throw new Error("no zoom applied on toggle: " + vb);
    await shot("03-dashboard-job-on");
  });
  await step("map wheel zoom + reset", async () => {
    const m = await page.$('.map[data-mapid="dash"]'); const bb = await m.boundingBox();
    await page.mouse.move(bb.x + bb.width/2, bb.y + bb.height/2); await page.mouse.wheel(0, -240); await wait(120);
    await click('[data-act="mapReset"][data-id="dash"]');
    const vb = await page.$eval('.map[data-mapid="dash"] svg', s => s.getAttribute("viewBox"));
    if (vb !== "0 0 640 520") throw new Error("reset failed: " + vb);
  });
  await step("reserved tabs renamed (F25)", async () => {
    const labels = await page.$$eval(".nav a.reserved span:first-of-type", els => els.map(e => e.textContent));
    for (const want of ["Email","Text","Mail","Enrichment"]) if (!labels.includes(want)) throw new Error("missing tab " + want + " in " + labels.join(","));
  });
  await step("new search: single control panel (no stepper)", async () => {
    await click('[data-act="newBatch"]'); await page.waitForSelector("#wz-name");
    if (await page.$(".stepper")) throw new Error("stepper still present (F26)");
    for (const selr of [".builder-grid", ".cargo-flags", ".facet-list", '[data-act="wzAddLane"]']) if (!(await page.$(selr))) throw new Error("missing " + selr + " on one page");
    await shot("04-builder-panel");
  });
  await step("new search: 5 layout options render (F48)", async () => {
    const sig = { 2:".canvas-dock", 3:".cols-grid", 4:".tabs", 5:".chipbar" };
    for (const l of [2,3,4,5]) {
      await page.evaluate(l => ACT.nsLayout({ l }), l); await wait(150);
      if (!(await page.$(sig[l]))) throw new Error("layout " + l + " missing " + sig[l]);
      await shot("04-layout-" + l);
    }
    await ev(() => { const b = document.querySelector('.chipbar .defchip'); ACT.nsDrawer({ d: "freight" }); }); await wait(120);
    if (!(await page.$(".drawer"))) throw new Error("L5 drawer did not open");
    await shot("04-layout-5-drawer");
    await ev(() => { state.nsDrawer = null; ACT.nsLayout({ l: 1 }); }); await wait(120);
  });
  await step("builder: name + lanes + facets + filters, live count", async () => {
    await page.fill("#wz-name", "SH-130 Corridor Recruitment"); await page.fill('[data-model="wizard.customer"]', "Central TX Materials");
    await click('[data-act="wzAddLane"][data-t="radius"]'); await click('[data-act="wzSaveLane"]');
    await click('[data-act="wzAddLane"][data-t="corridor"]'); await click('[data-act="wzSaveLane"]');
    const lanes = await page.$$eval(".lane", e => e.length); if (lanes < 2) throw new Error("lanes=" + lanes);
    const before = await page.textContent("#b-foot-count");
    await ev(() => ACT.wzFilter({ k: "hasEmail", value: true })); await wait(120);
    const after = await page.textContent("#b-foot-count");
    if (before === after) throw new Error("count did not react " + before + "→" + after);
    await ev(() => ACT.wzFilter({ k: "hasEmail", value: false }));
    await ev(() => { const b = document.querySelector('[data-act="wzOther"][data-m="exc"]'); ACT.wzOther({ v: b.getAttribute("data-v"), m: "exc" }); });
    await shot("05-builder-filled");
  });
  await step("grab batch → working page", async () => { await click('[data-act="wzGrab"]'); await page.waitForSelector("#wl-body table.tbl"); });
  await step("batch: activity collapsed below tiles (F32)", async () => {
    if (!(await page.$(".feed-bar"))) throw new Error("collapsed feed-bar missing");
    const order = await ev(() => { const c = document.querySelector(".content .page"); const strip = [...c.children].findIndex(e => e.querySelector && e.querySelector(".strip, .cell")); return c.innerHTML.indexOf("feed-bar") > c.innerHTML.indexOf('class="strip"'); });
    if (!order) throw new Error("feed not below strip");
    await click(".feed-bar"); await page.waitForSelector(".composer"); await shot("06-activity-open");
    await click('[data-act="toggleFeed"]');
  });
  await step("batch: warnings + Tags columns, money format, quick channels (F33/F36/F44/F47)", async () => {
    const heads = await page.$$eval("#wl-body thead th", els => els.map(e => e.textContent.trim()));
    if (!heads.includes("Warnings")) throw new Error("no Warnings column: " + heads.join("|"));
    if (!heads.includes("Tags")) throw new Error("no Tags column (F44): " + heads.join("|"));
    if (heads.includes("#")) throw new Error("# column should be replaced (F44)");
    if (!(await page.$(".wchips.stack"))) throw new Error("warnings not stacked");
    const html = await page.$eval("#wl-body", e => e.innerHTML);
    if (!/MM</.test(html)) throw new Error("money MM format not found");
    if (/\$\dM</.test(html)) throw new Error("old $xM format still present");
    const quick = await page.$$eval("#wl-body tbody tr:first-child [data-act='logCall']", els => els.map(e => e.getAttribute("data-channel")));
    for (const ch of ["call","text","email"]) if (!quick.includes(ch)) throw new Error("missing quick-log channel " + ch + ": " + quick.join(","));
    const headHtml = await page.$eval(".page-head", e => e.textContent);
    if (/Material —|Fill sand/.test(headHtml)) throw new Error("lane chip still in header (F42)");
    await shot("07-batch-table");
  });
  await step("batch: map view w/ teardrop pins + zoom", async () => {
    await click('[data-act="listView"][data-v="map"]'); await page.waitForSelector(".pin.tear");
    await click('[data-act="mapZoom"][data-id="batch"]'); await shot("08-batch-map"); await click('[data-act="listView"][data-v="list"]');
  });
  await step("log outreach + sheet", async () => {
    const r = await ev(() => { const b = document.querySelector('[data-act="logCall"]'); return { dot: b.getAttribute("data-dot"), batch: b.getAttribute("data-batch") }; });
    await page.evaluate(r => ACT.logCall({ dot: r.dot, batch: r.batch }), r); await page.waitForSelector(".modal .seg");
    await ev(() => ACT.submitLogBtn()); await wait(100);
    await ev(() => ACT.selAll({ value: true })); await wait(120);
    await click('[data-act="genContact"]'); await page.waitForSelector(".modal.lg"); await shot("09-contact-sheet");
    await ev(() => { state.modal = null; render(); }); await ev(() => ACT.clearSel());
  });
  await step("profile: Command Console locked (no switcher)", async () => {
    await ev(() => { const tr = document.querySelector("tr[data-act='openCarrier']"); ACT.openCarrier({ dot: tr.getAttribute("data-dot"), from: tr.getAttribute("data-from") }); });
    await page.waitForSelector(".console-grid");
    if (await page.$(".variant-switch")) throw new Error("variant switcher should be gone");
    await shot("10-profile-console");
  });
  await step("promote + dnc modals", async () => {
    await ev(() => { const b = document.querySelector('[data-act="promote"]'); if (b) ACT.promote({ dot: b.getAttribute("data-dot") }); });
    await page.waitForSelector(".modal"); await ev(() => { state.modal = null; render(); });
    await ev(() => { const el = document.querySelector('[data-act="toggleDnc"]'); ACT.toggleDnc({ dot: el.getAttribute("data-dot") }); });
    await page.waitForSelector(".modal"); await ev(() => { state.modal = null; render(); });
  });
  await step("users + guest gate + dark", async () => {
    await ev(() => ACT.nav({ to: "users" })); await page.waitForSelector('[data-act="approveUser"]');
    await ev(() => ACT.toggleTheme()); await ev(() => ACT.nav({ to: "dashboard" })); await wait(120); await shot("11-dashboard-dark");
    await ev(() => ACT.toggleTheme()); await ev(() => ACT.logout()); await page.waitForSelector('[data-act="demoLogin"]');
    await ev(() => ACT.demoLogin({ uid: "u_guest1" })); await wait(120);
    if (await page.$('[data-act="openBatch"]')) throw new Error("guest saw batches");
  });

  await browser.close();
  process.stdout.write("\nconsole.errors: " + consoleErrors.length + "\n"); consoleErrors.slice(0,15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("pageerrors: " + pageErrors.length + "\n"); pageErrors.slice(0,15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("external requests: " + external.length + "\n"); external.slice(0,15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("failed steps: " + failed.length + "\n");
  process.stdout.write("\nRESULT: " + (failed.length || consoleErrors.length || pageErrors.length || external.length ? "ISSUES" : "ALL CLEAR") + "\n");
})().catch(e => { process.stdout.write("FATAL " + e.message + "\n"); process.exit(1); });
