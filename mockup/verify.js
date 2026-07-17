/* Headless verification: render + interaction smoke test + screenshots. */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FILE = "file://" + path.resolve(__dirname, "index.html");
const SHOTS = path.resolve(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [], pageErrors = [], external = [], failed = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("request", (r) => { const u = r.url(); if (!/^(file:|data:|blob:|about:)/.test(u)) external.push(u); });

  const wait = (ms) => page.waitForTimeout(ms);
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + ".png") });
  const click = async (sel) => { await page.click(sel); await wait(120); };
  const step = async (name, fn) => { try { await fn(); process.stdout.write("  ok  " + name + "\n"); } catch (e) { failed.push(name); process.stdout.write("  XX  " + name + " -- " + e.message.split("\n")[0] + "\n"); } };

  await page.goto(FILE, { waitUntil: "domcontentloaded" });
  await wait(200);

  await step("login renders", async () => { await page.waitForSelector('[data-act="demoLogin"]'); await shot("01-login"); });
  await step("sign in as manager", async () => { await click('[data-act="demoLogin"][data-uid="u_manager"]'); await page.waitForSelector('[data-act="openBatch"]'); await shot("02-dashboard"); });
  await step("open new search", async () => { await click('[data-act="newBatch"]'); await page.waitForSelector("#b-count"); await shot("03-builder-radius"); });
  await step("live count reacts", async () => {
    const before = await page.textContent("#b-count");
    await page.evaluate(() => ACT.bWideNet({ value: false })); await wait(120);
    const after = await page.textContent("#b-count");
    if (before === after) throw new Error("count unchanged " + before);
    await page.evaluate(() => ACT.bWideNet({ value: true }));
  });
  await step("radius slider reacts", async () => {
    await page.evaluate(() => ACT.bRadius({ value: 100 })); await wait(120);
    if (!(await page.textContent("#b-count"))) throw new Error("no count");
  });
  await step("add cargo term via Enter key", async () => {
    const before = await page.$$eval("#b-terms .chip", e => e.length);
    await page.fill("#b-term-input", "Base rock"); await page.press("#b-term-input", "Enter"); await wait(140);
    const after = await page.$$eval("#b-terms .chip", e => e.length);
    if (after <= before) throw new Error("term not added " + before + "->" + after);
  });
  await step("corridor mode", async () => { await click('[data-act="bMode"][data-m="corridor"]'); await page.waitForSelector('input[data-live="bBuffer"]'); await shot("04-builder-corridor"); });
  await step("back to dashboard", async () => { await click('[data-act="nav"][data-to="dashboard"]'); await page.waitForSelector('[data-act="openBatch"]'); });
  await step("open batch -> list", async () => { await click('[data-act="openBatch"]'); await page.waitForSelector("table.tbl"); await shot("05-working-list"); });
  await step("filter interested", async () => { await click('[data-act="listStatus"][data-s="interested"]'); await shot("06-list-interested"); await click('[data-act="listStatus"][data-s="all"]'); });
  await step("map view", async () => { await click('[data-act="listView"][data-v="map"]'); await page.waitForSelector(".map svg"); await shot("07-list-map"); await click('[data-act="listView"][data-v="list"]'); });
  await step("select all + bulk contact", async () => {
    await page.evaluate(() => ACT.selAll({ value: true })); await wait(150); await shot("08-bulk-bar");
    await click('[data-act="genContact"]'); await page.waitForSelector(".modal"); await shot("08b-contact-modal");
    await page.click(".modal-head"); await wait(80);
    if (!(await page.$(".modal"))) throw new Error("modal closed on inner click");
    await page.click('.modal-foot [data-act="closeModal"]'); await wait(80);
    if (await page.$(".modal")) throw new Error("modal did not close on Done");
    await page.evaluate(() => ACT.clearSel());
  });
  await step("row status change", async () => {
    const r = await page.evaluate(() => { const s = document.querySelector('select[data-change="rowStatus"]'); if (!s) return null; return { dot: s.getAttribute("data-dot"), batch: s.getAttribute("data-batch") }; });
    if (r) { await page.evaluate((r) => ACT.rowStatus({ dot: r.dot, batch: r.batch, value: "contacted" }), r); }
  });
  await step("open carrier via real row click (guard lets it through)", async () => {
    await page.click("tr[data-act='openCarrier'] td:nth-child(2)");
    await page.waitForSelector('[data-act="profileTab"]'); await shot("09-profile");
  });
  await step("insurance + safety tabs", async () => { await page.evaluate(() => ACT.profileTab({ t: "insurance" })); await wait(100); await shot("10a-insurance"); await page.evaluate(() => ACT.profileTab({ t: "safety" })); await wait(100); await shot("10b-safety"); await page.evaluate(() => ACT.profileTab({ t: "overview" })); });
  await step("global DNC modal", async () => {
    await page.evaluate(() => { const el = document.querySelector('[data-act="toggleDnc"]'); ACT.toggleDnc({ dot: el.getAttribute("data-dot") }); });
    await page.waitForSelector(".modal"); await shot("11-dnc-modal");
    await page.evaluate(() => { const b = document.querySelector('[data-act="confirmDnc"]'); ACT.confirmDnc({ dot: b.getAttribute("data-dot") }); }); await wait(120);
  });
  await step("send to onboarding modal", async () => {
    await page.evaluate(() => ACT.nav({ to: "dashboard" })); await wait(80);
    await page.evaluate(() => { const tr = document.querySelector("tr[data-act='openCarrier']"); ACT.openBatch({ id: document.querySelector('[data-act=openBatch]').getAttribute("data-id") }); });
    await wait(80);
    await page.evaluate(() => { const tr = document.querySelector("tr[data-act='openCarrier']"); ACT.openCarrier({ dot: tr.getAttribute("data-dot"), from: tr.getAttribute("data-from") }); }); await wait(80);
    await page.evaluate(() => { const b = document.querySelector('[data-act="sendOnboard"]'); if (b) ACT.sendOnboard({ dot: b.getAttribute("data-dot") }); });
    await page.waitForSelector(".modal"); await shot("11b-onboard");
    await page.evaluate(() => { state.modal = null; render(); });
  });
  await step("users screen", async () => { await page.evaluate(() => ACT.nav({ to: "users" })); await page.waitForSelector('[data-act="approveUser"]'); await shot("12-users"); });
  await step("approve modal", async () => { await page.evaluate(() => { const b = document.querySelector('[data-act="approveUser"]'); ACT.approveUser({ uid: b.getAttribute("data-uid") }); }); await page.waitForSelector(".modal"); await shot("13-approve"); await page.evaluate(() => { state.modal = null; render(); }); });
  await step("dark theme", async () => { await page.evaluate(() => ACT.toggleTheme()); await page.evaluate(() => ACT.nav({ to: "dashboard" })); await wait(140); await shot("14-dashboard-dark"); });
  await step("builder dark", async () => { await page.evaluate(() => ACT.newBatch()); await wait(140); await shot("14b-builder-dark"); });
  await step("guest role gate", async () => {
    await page.evaluate(() => ACT.toggleTheme());
    await page.evaluate(() => ACT.logout()); await page.waitForSelector('[data-act="demoLogin"]');
    await page.evaluate(() => ACT.demoLogin({ uid: "u_guest1" })); await wait(140);
    if (await page.$('[data-act="openBatch"]')) throw new Error("guest saw batches!");
    await shot("15-guest-gate");
  });

  await browser.close();
  process.stdout.write("\nconsole.errors: " + consoleErrors.length + "\n");
  consoleErrors.slice(0, 15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("pageerrors: " + pageErrors.length + "\n");
  pageErrors.slice(0, 15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("external requests: " + external.length + "\n");
  external.slice(0, 15).forEach(e => process.stdout.write("   ! " + e + "\n"));
  process.stdout.write("failed steps: " + failed.length + "\n");
  process.stdout.write("\nRESULT: " + (failed.length || consoleErrors.length || pageErrors.length || external.length ? "ISSUES" : "ALL CLEAR") + "\n");
})().catch(e => { process.stdout.write("FATAL " + e.message + "\n"); process.exit(1); });
