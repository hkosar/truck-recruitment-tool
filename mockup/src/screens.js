/* ============================================================================
   screens.js — v2 screens, multi-lane map, modals, menus.
   ============================================================================ */

function statusVar(s) { return "var(--st-" + ({ not_a_fit:"notfit" }[s] || s) + ")"; }
const CITY_NAMES = CITIES.map(c => c.name);

/* ------------------------------- map ------------------------------- */
function mapCore(pins, zones) {
  const W = 640, H = 520, proj = makeProjection(W, H, 16);
  const land = proj.pathFor(TX_OUTLINE);
  const anchorMark = (x, y) => '<circle class="anchor" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5"/>';
  const laneChip = (x, y, zi) => { const L = "ABCDEFGH"[zi] || "?"; return '<circle class="lane-chip-bg" cx="' + x.toFixed(1) + '" cy="' + (y-14).toFixed(1) + '" r="8"/><text class="lane-chip-tx" x="' + x.toFixed(1) + '" y="' + (y-14).toFixed(1) + '">' + L + "</text>"; };
  let overlay = "";
  (zones || []).forEach((z, zi) => {
    if (z.type === "radius") {
      const p = proj.project(z.anchorLng, z.anchorLat), r = proj.milesToPx(z.radiusMi);
      overlay += '<circle class="radius-fill" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r.toFixed(1) + '"/>' + anchorMark(p[0], p[1]) + laneChip(p[0], p[1], zi);
    } else if (z.type === "corridor" && z.route) {
      const pts = z.route.map(q => proj.project(q.lng, q.lat));
      const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
      const bw = proj.milesToPx(z.bufferMi) * 2;
      overlay += '<path class="corridor-band" style="stroke-width:' + bw.toFixed(1) + 'px" d="' + d + '"/><path class="corridor-line" d="' + d + '"/>' + pts.map(p => anchorMark(p[0], p[1])).join("") + laneChip(pts[0][0], pts[0][1], zi);
    }
  });
  const cityDots = CITIES.filter(c => c.major).map(c => { const p = proj.project(c.lng, c.lat); return '<circle class="city-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2"/><text class="city-lbl" x="' + (p[0]+5).toFixed(1) + '" y="' + (p[1]+3).toFixed(1) + '">' + esc(c.name) + "</text>"; }).join("");
  const pinEls = pins.map(p => {
    const q = proj.project(p.lng, p.lat), fill = p.fill || "var(--accent)";
    const inter = p.dot ? ' data-act="openCarrier" data-dot="' + p.dot + '" data-from="' + (p.from||"") + '" style="cursor:pointer;fill:' + fill + '"' : ' style="fill:' + fill + '"';
    const ring = p.warn ? '<circle class="pin-ring" cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="' + ((p.r||6)+2.5) + '"/>' : "";
    const num = p.num != null ? '<text class="pin-lbl" x="' + q[0].toFixed(1) + '" y="' + q[1].toFixed(1) + '">' + p.num + "</text>" : "";
    return ring + '<circle class="pin ' + (p.cls||"") + '" cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="' + (p.r||6) + '"' + inter + "><title>" + esc(p.title||"") + "</title></circle>" + num;
  }).join("");
  return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet"><path class="tx-land" d="' + land + '"/>' + cityDots + overlay + pinEls + "</svg>";
}
function mapCount(n, label) { return '<div class="map-count"><b id="b-count">' + n + "</b><span>" + (label||"matches") + "</span></div>"; }
function mapLegend(rows) { return '<div class="map-legend">' + rows.map(r => '<div class="lg"><span class="sw" style="background:' + r[0] + '"></span>' + r[1] + "</div>").join("") + "</div>"; }
function statusLegend(counts) {
  const rows = STATUS_ORDER.map(k => [statusVar(k), STATUS[k].label + (counts ? " · " + counts[k] : "")]);
  if (counts && counts.dnc) rows.push(["var(--st-dnc)", "Do Not Call · " + counts.dnc]);
  return mapLegend(rows);
}

/* ------------------------------- shell ------------------------------- */
function sidebar() {
  const u = cur();
  const pend = DB.users.filter(x => (state.overrides.userStatus[x.id]?.status || x.status) === "pending").length;
  const item = (act, to, ic, label, count, on) => '<a data-act="' + act + '"' + (to ? ' data-to="' + to + '"' : "") + ' class="' + (on ? "on" : "") + '">' + icon(ic) + "<span>" + label + "</span>" + (count != null ? '<span class="count">' + count + "</span>" : "") + "</a>";
  const reserved = (ic, label) => '<a class="reserved" data-act="reservedTab" data-label="' + label + '">' + icon(ic) + "<span>" + label + '</span><span class="soon">soon</span></a>';
  return '<aside class="sidebar">' +
    '<div class="brand"><div class="mark">' + icon("nail") + '</div><div><div class="name">Twisted Nail</div><div class="sub">Recruiter</div></div></div>' +
    '<nav class="nav">' +
      '<div class="nav-label eyebrow">Recruiting</div>' +
      item("nav", "dashboard", "layers", "Dashboard", DB.batches.length, ["dashboard","workingList"].includes(state.screen)) +
      item("newBatch", null, "search", "New Search", null, state.screen === "wizard") +
      '<div class="nav-label eyebrow reserved">Outreach</div>' +
      reserved("mail", "Email Blasts") + reserved("message", "Texting") + reserved("send", "Postcards") + reserved("building", "Enrichment") +
      (u.role === "manager" ? '<div class="nav-label eyebrow">Admin</div>' + item("nav", "users", "users", "Users", pend || null, state.screen === "users") : "") +
    "</nav>" +
    '<div class="side-foot"><button class="usercell" data-act="userMenu">' + avatar(u) + '<span class="who"><span class="nm">' + esc(u.name) + '</span><span class="rl">' + ROLE_LABEL[u.role] + "</span></span><span style=\"margin-left:auto;color:var(--text-subtle)\">" + icon("chevD") + "</span></button></div>" +
    "</aside>";
}
function topbar(crumbs) {
  return '<header class="topbar"><div class="crumbs">' + crumbs + '</div><div class="spacer"></div>' +
    '<span class="badge good" title="Shared list — updates live for all users"><span class="dot"></span>Live</span>' +
    '<button class="btn icon ghost" data-act="toggleTheme" title="Toggle theme">' + icon("sun") + "</button></header>";
}
function appShell(inner, crumbs) { return '<div class="shell">' + sidebar() + '<div class="main">' + topbar(crumbs) + '<div class="content">' + inner + "</div></div></div>"; }
function crumb(items) { return items.map((it, i) => (i ? '<span style="color:var(--text-subtle)">' + icon("chevR") + "</span>" : "") + (it.act ? '<a data-act="' + it.act + '"' + (it.to ? ' data-to="' + it.to + '" data-id="' + it.to + '"' : "") + ' style="cursor:pointer">' + esc(it.label) + "</a>" : '<span class="' + (i === items.length-1 ? "cur" : "") + '">' + esc(it.label) + "</span>")).join(""); }
function sel(a, b) { return a === b ? " selected" : ""; }
function cityOptions(v) { return CITY_NAMES.map(n => '<option value="' + n + '"' + sel(v, n) + ">" + n + ", TX</option>").join(""); }

/* ------------------------------- shared bits ------------------------------- */
function insBadge(c) { const v = c.ins.bipd_on_file; const cls = v >= 1000000 ? "good" : (v >= 500000 ? "warn" : "crit"); return '<span class="badge ' + cls + '">' + fmtMoney(v) + "</span>"; }
function warnChips(dot) { const w = warnListFor(dot); if (!w.length) return ""; return '<span class="wchips">' + w.map(x => '<span class="wchip ' + x.tone + '">' + icon("alert") + esc(x.label) + "</span>").join("") + "</span>"; }
function contactCell(c) {
  const nm = c.contact_name ? "<div>" + esc(c.contact_name) + "</div>" : '<div class="miss">no contact name</div>';
  const ph = (c.phone || c.cell) ? '<a class="mono" href="tel:' + (c.phone||c.cell).replace(/[^0-9]/g,"") + '">' + esc(c.phone||c.cell) + "</a>" : '<span class="miss mono">no phone</span>';
  const em = c.email ? '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + "</a>" : '<span class="miss">no email</span>';
  return '<div class="ccell">' + nm + ph + em + "</div>";
}
function laneSummary(b) { return b.zones.map((z, i) => "ABCDEFGH"[i] + " " + (z.type === "radius" ? z.anchor + " · " + z.radiusMi + "mi" : z.origin.replace(", TX","") + "→" + z.dest.replace(", TX","") + " · " + z.bufferMi + "mi")).join("  ·  "); }
function stat(k, v, cls) { return '<div class="cell ' + (cls||"") + '"><div class="k">' + k + '</div><div class="v">' + v + "</div></div>"; }
function statStrip(cells) { return '<div class="strip">' + cells + "</div>"; }

/* ------------------------------- AUTH ------------------------------- */
function authBrand() { return '<div class="auth-brand"><div class="mark">' + icon("nail") + '</div><div><div class="name">Twisted Nail</div><div class="sub">Carrier Recruiter</div></div></div>'; }
function screenLogin() {
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<form class="auth-panel" data-submit="signIn"><h1>Sign in</h1><p class="lead">Recruit sand &amp; gravel carriers across Texas.</p>' +
    '<div class="stack gap-16"><label class="field"><span class="label">Work email</span><span class="input-group">' + icon("mail") + '<input class="input" type="email" value="hunter@twistednail.com"></span></label>' +
    '<label class="field"><span class="label">Password</span><span class="input-group">' + icon("lock") + '<input class="input" type="password" value="demo"></span></label>' +
    '<div class="auth-row"><label class="check"><input type="checkbox" checked><span class="box">' + icon("check") + '</span><span>Remember me</span></label><a class="link" data-act="gotoAuth" data-view="forgot">Forgot password?</a></div>' +
    '<button class="btn primary lg block" type="submit">Sign in</button></div>' +
    '<div class="demo-note"><b>Prototype — sign in as any role:</b><div class="row wrap gap-6 mt-8">' +
      DB.users.filter(u => u.status === "approved").map(u => '<button type="button" class="btn sm" data-act="demoLogin" data-uid="' + u.id + '">' + esc(u.name.split(" ")[0]) + " · " + ROLE_LABEL[u.role] + "</button>").join("") +
      '<button type="button" class="btn sm" data-act="demoLogin" data-uid="u_guest1">New guest</button></div></div>' +
    "</form><div class=\"auth-foot\">New here? <a class=\"link\" data-act=\"gotoAuth\" data-view=\"register\">Create an account</a></div></div></div>";
}
function screenRegister() {
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<form class="auth-panel" data-submit="doRegister"><h1>Create your account</h1><p class="lead">New accounts start as a guest until a manager approves them.</p>' +
    '<div class="stack gap-16"><label class="field"><span class="label">Full name</span><input class="input" value="Cole Ramirez"></label>' +
    '<label class="field"><span class="label">Work email</span><input class="input" type="email" value="cole.r@gmail.com"></label>' +
    '<label class="field"><span class="label">Password</span><input class="input" type="password" value="demo"></label>' +
    '<button class="btn primary lg block" type="submit">Create account</button></div></form>' +
    '<div class="auth-foot">Already have an account? <a class="link" data-act="gotoAuth" data-view="login">Sign in</a></div></div></div>';
}
function screenForgot() {
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<form class="auth-panel" data-submit="doForgot"><h1>Reset password</h1><p class="lead">We\'ll email you a reset link.</p>' +
    '<div class="stack gap-16"><label class="field"><span class="label">Work email</span><input class="input" type="email" value="hunter@twistednail.com"></label>' +
    '<button class="btn primary lg block" type="submit">Send reset link</button></div></form>' +
    '<div class="auth-foot"><a class="link" data-act="gotoAuth" data-view="login">Back to sign in</a></div></div></div>';
}
function screenGuest() {
  const u = cur();
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<div class="auth-panel" style="text-align:center"><div style="width:52px;height:52px;border-radius:50%;background:var(--warn-tint);color:var(--warn);display:grid;place-items:center;margin:4px auto 14px">' + icon("clock") + "</div>" +
    "<h1>Account pending approval</h1><p class='lead' style='margin-bottom:18px'>Thanks, " + esc(u ? u.name.split(" ")[0] : "there") + ". A manager needs to review and provision your account before you can access the recruiting tools.</p>" +
    '<button class="btn block mt-16" data-act="logout">' + icon("logout") + " Sign out</button></div>" +
    '<div class="auth-foot subtle">Guests only see this page until approved — that\'s the role gate.</div></div></div>';
}

/* ------------------------------- DASHBOARD (F3/F4) ------------------------------- */
function allZones() { const z = []; DB.batches.forEach((b, bi) => b.zones.forEach(zone => z.push(Object.assign({ _batch: bi }, zone)))); return z; }
function screenDashboard() {
  const totalCarriers = new Set(DB.batchCarriers.map(b => b.dot)).size;
  const interested = DB.batchCarriers.filter(b => effStatus(b.batch_id, b.dot) === "interested" && !effDnc(b.dot)).length;
  const promoted = new Set(DB.batchCarriers.filter(b => effPromoted(b.dot)).map(b => b.dot)).size;
  const withPhone = new Set(DB.batchCarriers.filter(b => { const c = DB.carrierByDot[b.dot]; return c.phone || c.cell; }).map(b => b.dot)).size;
  const strip = statStrip(stat("Active batches", DB.batches.length) + stat("Carriers in play", totalCarriers) + stat("With phone", withPhone) + stat("Interested", interested, "good") + stat("Promoted", promoted, "accent"));
  // overview map: batch anchor pins + all zones
  const batchPins = DB.batches.map((b, bi) => { const z = b.zones[0]; const p = z.type === "radius" ? { lng:z.anchorLng, lat:z.anchorLat } : { lng:z.originLng, lat:z.originLat }; return { lng:p.lng, lat:p.lat, num: bi+1, fill:"var(--accent)", title:b.name, r:9 }; });
  const map = '<div class="map" style="height:340px">' + mapCore(batchPins, allZones()) + mapLegend(DB.batches.map((b, bi) => ["var(--accent)", (bi+1) + " · " + b.name])) + "</div>";
  const rows = DB.batches.map((b, bi) => {
    const c = statusCounts(b.id), total = c.total || 1;
    const pipe = STATUS_ORDER.map(k => c[k] ? '<i style="width:' + (c[k]/total*100) + '%;background:' + statusVar(k) + '"></i>' : "").join("") + (c.dnc ? '<i style="width:' + (c.dnc/total*100) + '%;background:var(--st-dnc)"></i>' : "");
    const la = activityForBatch(b.id)[0];
    return '<tr class="clickable" data-act="openBatch" data-id="' + b.id + '">' +
      '<td class="mono" style="width:28px;text-align:center;color:var(--accent-press);font-weight:800">' + (bi+1) + "</td>" +
      "<td><div class='co'><span class='nm'>" + esc(b.name) + "</span><span class='meta'>" + esc(b.customer) + " · " + esc(b.job) + "</span></div></td>" +
      "<td style='font-size:11.5px;color:var(--text-muted)'>" + esc(laneSummary(b)) + "</td>" +
      "<td class='mono'>" + c.total + "</td>" +
      '<td><div class="pipebar">' + pipe + "</div></td>" +
      "<td class='mono' style='color:var(--st-interested)'>" + c.interested + "</td>" +
      "<td>" + (c.warnings ? '<span class="wchip crit">' + icon("alert") + c.warnings + "</span>" : '<span class="subtle">—</span>') + "</td>" +
      "<td class='muted' style='font-size:12px'>" + (la ? fmtRel(la.at) : "—") + "</td>" +
      '<td class="right"><button class="btn icon ghost sm" data-act="batchMenu" data-id="' + b.id + '">' + icon("dots") + "</button></td></tr>";
  }).join("");
  const table = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Batch</th><th>Lanes</th><th>Carriers</th><th>Pipeline</th><th>Interested</th><th>Warn</th><th>Last activity</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  const inner = '<div class="page wide"><div class="page-head"><div><div class="h1">Dashboard</div><div class="desc">Every active recruiting batch, mapped and listed. Click a row to open its workspace.</div></div><div class="spacer"></div><button class="btn primary" data-act="newBatch">' + icon("plus") + " New Search</button></div>" +
    strip + '<div class="mt-16">' + map + "</div><div class=\"mt-16\">" + table + "</div></div>";
  return appShell(inner, crumb([{ label:"Dashboard" }]));
}

/* ------------------------------- WIZARD (F20/F21/F12/F13/F14/F15/F16) ------------------------------- */
function newWizard() {
  return { step:1, name:"", customer:"", job:"",
    lanes:[], editing:null,
    cargo:{ flags:SG_FLAGS.slice(), other:{ enabled:true, include:SG_OTHER_VALUES.slice(), exclude:[] }, q:"" },
    filters:{ insuranceMin:0, keepBelow:true, size:"any", forHire:true, activeOnly:true, authorizedOnly:false, interstateOnly:false, hasPhone:false, hasEmail:false } };
}
const SIZE_RANGES = { any:[null,null], small:[1,5], mid:[6,20], large:[21,999] };
function wizardSearch(w) {
  const sz = SIZE_RANGES[w.filters.size];
  return { zones:w.lanes, cargo:w.cargo, forHire:w.filters.forHire, activeOnly:w.filters.activeOnly, authorizedOnly:w.filters.authorizedOnly,
    interstateOnly:w.filters.interstateOnly, sizeMin:sz[0], sizeMax:sz[1], hasPhone:w.filters.hasPhone, hasEmail:w.filters.hasEmail,
    insuranceMin:+w.filters.insuranceMin, keepBelow:w.filters.keepBelow };
}
function wizardZones(w) { return w.editing ? w.lanes.concat([w.editing]).filter(z => z.type) : w.lanes; }
function screenWizard() {
  const w = state.wizard, steps = ["Details","Lanes","Freight","Filters & Review"];
  const stepper = '<div class="stepper">' + steps.map((s, i) => { const n = i+1; const cls = n === w.step ? "on" : (n < w.step ? "done" : ""); return (i ? '<div class="bar"></div>' : "") + '<div class="step ' + cls + '"><span class="num">' + (n < w.step ? icon("check") : n) + '</span><span class="lbl">' + s + "</span></div>"; }).join("") + "</div>";
  let body;
  if (w.step === 1) body = wizStep1(w);
  else body = '<div class="wizard-grid">' + (w.step === 2 ? wizStep2(w) : w.step === 3 ? wizStep3(w) : wizStep4(w)) + wizMapPane(w) + "</div>";
  const inner = '<div class="page wide" style="padding-bottom:88px"><div class="page-head"><div><div class="h1">New Search</div><div class="desc">Name the job, draw the lanes, dial in the freight and filters, then grab the batch.</div></div></div>' +
    '<div style="margin-bottom:18px">' + stepper + "</div>" + body + wizFooter(w) + "</div>";
  return appShell(inner, crumb([{ label:"Dashboard", act:"nav", to:"dashboard" }, { label:"New Search" }]));
}
function wizMapPane(w) {
  const s = wizardSearch(w), zones = wizardZones(w), matches = searchMatches(Object.assign({}, s, { zones }));
  const pins = matches.slice(0, 400).map(c => ({ lng:c.lng, lat:c.lat, r:4, warn:warningsFor(c).length > 0, title:c.legal_name }));
  return '<div class="wizard-map"><div class="map" style="height:440px" id="wiz-map">' + mapCore(pins, zones) + mapCount(matches.length) + mapLegend([["var(--accent)","Matches filters"],["var(--crit)","Has a warning flag"]]) + "</div>" +
    '<div class="subtle" style="font-size:11px;margin-top:6px">Coverage is the union of all lanes. Live count is approximate here; the real tool computes it server-side.</div></div>';
}
function wizStep1(w) {
  return '<div class="card" style="padding:22px;max-width:620px"><div class="stack gap-16">' +
    '<label class="field"><span class="label">Batch name</span><input class="input lg" style="font-size:16px;font-weight:600" placeholder="e.g. Belt Construction Recruitment" value="' + esc(w.name) + '" data-model="wizard.name" id="wz-name"></label>' +
    '<div class="row gap-16"><label class="field grow"><span class="label">Customer</span><input class="input" list="wz-customers" placeholder="Who is this for?" value="' + esc(w.customer) + '" data-model="wizard.customer"><datalist id="wz-customers">' + [...new Set(DB.batches.map(b => b.customer))].map(c => '<option value="' + esc(c) + '">').join("") + "</datalist></label>" +
    '<label class="field grow"><span class="label">Job</span><input class="input" placeholder="What job / project?" value="' + esc(w.job) + '" data-model="wizard.job"></label></div>' +
    '<div class="subtle" style="font-size:12.5px">A batch is a recruitment session for a customer\'s job — you can add multiple material lanes next.</div></div></div>';
}
function wizStep2(w) {
  const laneList = w.lanes.length ? w.lanes.map((z, i) => '<div class="lane"><div class="idx">' + "ABCDEFGH"[i] + '</div><div class="lmeta"><div class="lmat">' + esc(z.label || (z.type === "radius" ? "Radius lane" : "Corridor lane")) + '</div><div class="lgeo">' + (z.type === "radius" ? icon("target") + " " + esc(z.anchor) + " · " + z.radiusMi + " mi" : icon("route") + " " + esc(z.origin) + " → " + esc(z.dest) + " · " + z.bufferMi + " mi") + '</div></div><button class="btn icon ghost sm" data-act="wzEditLane" data-id="' + z.id + '">' + icon("edit") + '</button><button class="btn icon ghost sm" data-act="wzRmLane" data-id="' + z.id + '">' + icon("x") + "</button></div>").join("") : '<div class="subtle" style="font-size:13px;padding:8px 0">No lanes yet — add a radius or a corridor. Coverage is the union of every lane (your "asterisk").</div>';
  return '<div class="card" style="padding:18px"><div class="eyebrow" style="margin-bottom:10px">Lanes <span class="subtle">· ' + w.lanes.length + "</span></div>" + laneList +
    (w.editing ? wizLaneEditor(w) : '<div class="row gap-8 mt-16"><button class="btn" data-act="wzAddLane" data-t="radius">' + icon("target") + ' Add radius lane</button><button class="btn" data-act="wzAddLane" data-t="corridor">' + icon("route") + " Add corridor lane</button></div>") + "</div>";
}
function wizLaneEditor(w) {
  const e = w.editing;
  const anchorSeg = ["pin","address","city","zip","county"].map(t => '<button type="button" class="' + (e.anchorKind === t ? "on" : "") + '" data-act="wzAnchorKind" data-t="' + t + '">' + ({pin:"Pin",address:"Address",city:"City",zip:"ZIP",county:"County"}[t]) + "</button>").join("");
  if (e.type === "radius") {
    return '<div class="lane-editor mt-16"><div class="eyebrow" style="margin-bottom:10px">New radius lane</div><div class="stack gap-12">' +
      '<label class="field"><span class="label">Material / lane label</span><input class="input" placeholder="e.g. Concrete sand — Austin pit" value="' + esc(e.label) + '" data-model="wizard.editing.label"></label>' +
      '<div class="field"><span class="label">Center on</span><div class="seg" style="flex-wrap:wrap;margin-bottom:8px">' + anchorSeg + "</div>" +
      '<select class="select" data-change="wzAnchorCity">' + cityOptions(e.anchor) + "</select></div>" +
      '<div class="field"><div class="row between"><span class="label">Radius</span><span class="label mono" id="wz-r-lbl">' + e.radiusMi + ' mi</span></div><input type="range" min="10" max="150" step="5" value="' + e.radiusMi + '" data-echo="wz-r-lbl" data-echo-fmt="mi" data-live="wzRadius"></div>' +
      '<div class="row gap-8 end"><button class="btn" data-act="wzCancelLane">Cancel</button><button class="btn primary" data-act="wzSaveLane">' + icon("check") + " Add lane</button></div></div></div>";
  }
  return '<div class="lane-editor mt-16"><div class="eyebrow" style="margin-bottom:10px">New corridor lane <span class="subtle">· custom pickup &amp; dropoff</span></div><div class="stack gap-12">' +
    '<label class="field"><span class="label">Material / lane label</span><input class="input" placeholder="e.g. Crushed limestone — Dallas quarry" value="' + esc(e.label) + '" data-model="wizard.editing.label"></label>' +
    '<div class="row gap-12"><label class="field grow"><span class="label">Pickup</span><select class="select" data-change="wzOrigin">' + cityOptions(e.origin) + "</select></label>" + icon("arrowR") + '<label class="field grow"><span class="label">Dropoff</span><select class="select" data-change="wzDest">' + cityOptions(e.dest) + "</select></label></div>" +
    '<div class="field"><div class="row between"><span class="label">Within</span><span class="label mono" id="wz-b-lbl">' + e.bufferMi + ' mi</span></div><input type="range" min="10" max="80" step="5" value="' + e.bufferMi + '" data-echo="wz-b-lbl" data-echo-fmt="mi" data-live="wzBuffer"><div class="subtle" style="font-size:11px;margin-top:4px">Distance from <b>any point</b> along the run.</div></div>' +
    '<div class="row gap-8 end"><button class="btn" data-act="wzCancelLane">Cancel</button><button class="btn primary" data-act="wzSaveLane">' + icon("check") + " Add lane</button></div></div></div>";
}
function wizStep3(w) {
  const s = wizardSearch(w), zones = wizardZones(w);
  // scoped counts: geo + non-cargo filters, cargo removed
  const scope = Object.assign({}, s, { zones, cargo: null });
  const scopeMatches = searchMatches(scope);
  const flagCount = f => scopeMatches.filter(c => c.cargoFlags.includes(f)).length;
  const flags = DB.CARGO_FLAGS.map(f => '<label class="flag-row"><input type="checkbox" class="hide" ' + (w.cargo.flags.includes(f) ? "checked" : "") + ' data-change="wzFlag" data-f="' + esc(f) + '"><span class="box" style="width:16px;height:16px;border-radius:4px;border:1.5px solid var(--border-strong);display:grid;place-items:center;flex:none;' + (w.cargo.flags.includes(f) ? "background:var(--accent);border-color:var(--accent)" : "") + '">' + (w.cargo.flags.includes(f) ? '<span style="color:#fff;display:grid">' + icon("check") + "</span>" : "") + '</span><span>' + esc(f) + '</span><span class="cnt">' + flagCount(f) + "</span></label>").join("");
  // Other facet values scoped
  const q = (w.cargo.q || "").toLowerCase();
  const otherScope = DB.cargoOtherValues.map(v => ({ v: v.value, group: v.group, count: scopeMatches.filter(c => c.cargo_other_norm === v.value).length })).filter(v => v.count > 0 && (!q || v.v.toLowerCase().includes(q)));
  const inc = w.cargo.other.include, exc = w.cargo.other.exclude;
  const rows = otherScope.map(v => { const isI = inc.includes(v.v), isE = exc.includes(v.v); return '<div class="facet-row ' + (isI ? "inc" : isE ? "exc" : "") + '"><span class="fval">' + esc(v.v) + '</span><span class="cnt">' + v.count + '</span><span class="tri"><button class="inc' + (isI ? " on" : "") + '" data-act="wzOther" data-v="' + esc(v.v) + '" data-m="inc" title="Include">' + icon("plus") + '</button><button class="exc' + (isE ? " on" : "") + '" data-act="wzOther" data-v="' + esc(v.v) + '" data-m="exc" title="Exclude">' + icon("x") + "</button></span></div>"; }).join("");
  // suggested groups
  const groups = {}; DB.cargoOtherValues.forEach(v => { if (v.group) groups[v.group] = (groups[v.group]||0) + scopeMatches.filter(c => c.cargo_other_norm === v.value).length; });
  const sug = Object.keys(groups).filter(g => groups[g] > 0).sort((a,b) => groups[b]-groups[a]).map(g => '<span class="chip sugbar-chip" data-act="wzSuggest" data-g="' + esc(g) + '">' + esc(g) + ' <span class="cnt">' + groups[g] + "</span></span>").join("");
  return '<div class="stack gap-16"><div class="card" style="padding:18px"><div class="eyebrow" style="margin-bottom:10px">Cargo categories <span class="subtle">· FMCSA checkboxes</span></div><div class="cargo-flags">' + flags + "</div></div>" +
    '<div class="card" style="padding:18px"><div class="row between center" style="margin-bottom:8px"><div class="eyebrow">"Other" cargo — the sand &amp; gravel signal</div><label class="switch"><input type="checkbox" ' + (w.cargo.other.enabled ? "checked" : "") + ' data-change="wzOtherEnabled"><span class="track"></span></label></div>' +
    (w.cargo.other.enabled ? '<span class="input-group" style="max-width:100%;margin-bottom:10px">' + icon("search") + '<input class="input" id="wz-osearch" placeholder="Search Other values…" value="' + esc(w.cargo.q||"") + '" data-live="wzOtherSearch"></span>' +
      '<div class="subtle" style="font-size:11.5px;margin-bottom:6px">Suggested — click to include a whole group:</div><div class="sugbar" style="margin-bottom:12px">' + (sug || '<span class="subtle">no matches in scope</span>') + "</div>" +
      '<div class="facet-list" id="wz-facets">' + (rows || '<div class="facet-row"><span class="subtle">No Other values match this scope.</span></div>') + "</div>" +
      '<div class="facet-sum mt-12">' + icon("filter") + " Including <b>" + inc.length + "</b> values · Excluding <b>" + exc.length + "</b></div>"
      : '<div class="subtle" style="font-size:12.5px">Other-cargo matching is off. Enable it to browse the free-text values sand &amp; gravel carriers actually use.</div>') + "</div></div>";
}
function wizStep4(w) {
  const f = w.filters, s = wizardSearch(w), matches = searchMatches(s);
  const withPhone = matches.filter(c => c.phone || c.cell).length, withEmail = matches.filter(c => c.email).length, tier1 = matches.filter(c => c.tier === 1).length;
  const tog = (label, key) => '<label class="switch" style="justify-content:space-between;width:100%"><span class="label">' + label + '</span><span style="position:relative;display:inline-flex"><input type="checkbox" ' + (f[key] ? "checked" : "") + ' data-change="wzFilter" data-k="' + key + '"><span class="track"></span></span></label>';
  return '<div class="stack gap-16"><div class="card" style="padding:18px"><div class="eyebrow" style="margin-bottom:12px">Carrier filters</div><div class="stack gap-12">' +
    '<div class="field"><span class="label">Minimum insurance (BIPD)</span><select class="select" data-change="wzInsurance"><option value="0"' + sel(""+f.insuranceMin,"0") + '>Any</option><option value="500000"' + sel(""+f.insuranceMin,"500000") + '>$500K+</option><option value="750000"' + sel(""+f.insuranceMin,"750000") + '>$750K+</option><option value="1000000"' + sel(""+f.insuranceMin,"1000000") + '>$1MM+</option><option value="2000000"' + sel(""+f.insuranceMin,"2000000") + '>$2MM+</option></select>' +
    '<label class="switch mt-8" style="' + (f.insuranceMin ? "" : "opacity:.45;pointer-events:none") + '"><input type="checkbox" ' + (f.keepBelow ? "checked" : "") + ' data-change="wzKeepBelow"><span class="track"></span><span class="label">Keep below-threshold carriers visible</span></label></div>' +
    '<div class="field"><span class="label">Fleet size</span><select class="select" data-change="wzSize"><option value="any"' + sel(f.size,"any") + '>Any size</option><option value="small"' + sel(f.size,"small") + '>1–5 trucks</option><option value="mid"' + sel(f.size,"mid") + '>6–20 trucks</option><option value="large"' + sel(f.size,"large") + '>21+ trucks</option></select></div>' +
    tog("For-hire only","forHire") + tog("Active registration only","activeOnly") + tog("Authorized &amp; insured only","authorizedOnly") + tog("Interstate only","interstateOnly") +
    '<div class="divider" style="margin:4px 0"></div><div class="eyebrow">Contactability</div>' + tog("Has phone on file","hasPhone") + tog("Has email on file","hasEmail") +
    '<div class="demo-note" style="margin-top:6px">' + icon("alert") + ' Safety &amp; insurance issues are never filtered out — carriers with issues are highlighted in red everywhere.</div>' +
    "</div></div>" +
    '<div class="card" style="padding:18px"><div class="eyebrow" style="margin-bottom:10px">Coverage</div><div class="strip">' + stat("Matches", matches.length, "accent") + stat("With phone", withPhone) + stat("With email", withEmail, withEmail ? "" : "crit") + stat("Sand & gravel", tier1, "good") + "</div>" +
    '<div class="subtle" style="font-size:12px;margin-top:10px">' + Math.round(withEmail/Math.max(1,matches.length)*100) + '% have an email on file — FMCSA email coverage is genuinely thin, which is why calling leads.</div></div></div>';
}
function wizFooter(w) {
  const matches = searchMatches(wizardSearch(w)), n = matches.length;
  const withPhone = matches.filter(c => c.phone || c.cell).length, withEmail = matches.filter(c => c.email).length;
  const back = w.step > 1 ? '<button class="btn" data-act="wzStep" data-s="' + (w.step-1) + '">Back</button>' : '<button class="btn" data-act="nav" data-to="dashboard">Cancel</button>';
  const next = w.step < 4 ? '<button class="btn primary" data-act="wzStep" data-s="' + (w.step+1) + '">Next</button>' : '<button class="btn primary lg" data-act="wzGrab">' + icon("layers") + " Grab Batch — " + n + "</button>";
  return '<div class="wizfoot"><span class="wizcount"><b id="b-foot-count">' + n + '</b> carriers <span class="subcount"><span>' + withPhone + ' phone</span><span>' + withEmail + ' email</span></span></span><div class="spacer" style="flex:1"></div>' + back + next + "</div>";
}

const SCREENS = {
  login: screenLogin, register: screenRegister, forgot: screenForgot, guest: screenGuest,
  dashboard: screenDashboard, wizard: screenWizard, workingList: screenWorkingList,
  profile: screenProfile, users: screenUsers
};
