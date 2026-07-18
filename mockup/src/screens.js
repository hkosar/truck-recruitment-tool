/* ============================================================================
   screens.js — v3 screens: interactive map, dashboard, New Search control panel.
   ============================================================================ */

function statusVar(s) { return "var(--st-" + ({ not_a_fit:"notfit" }[s] || s) + ")"; }
const CITY_NAMES = CITIES.map(c => c.name);
const PROJ = makeProjection(640, 520, 16);

/* ------------------------------- map (F29/F37) ------------------------------- */
function tearPin(x, y, r, fill, num, warn, inter, title) {
  const rb = r;                       // bulb radius
  const cy = y - 2.3 * rb;            // bulb center
  const d = "M " + x + " " + y +
    " C " + (x - rb*1.05) + " " + (y - rb*1.0) + ", " + (x - rb*1.3) + " " + (y - rb*1.55) + ", " + (x - rb*1.3) + " " + cy +
    " A " + (rb*1.3) + " " + (rb*1.3) + " 0 1 1 " + (x + rb*1.3) + " " + cy +
    " C " + (x + rb*1.3) + " " + (y - rb*1.55) + ", " + (x + rb*1.05) + " " + (y - rb*1.0) + ", " + x + " " + y + " Z";
  const ring = warn ? '<circle class="pin-ring" cx="' + x + '" cy="' + cy + '" r="' + (rb*1.75) + '"/>' : "";
  const numEl = num != null ? '<text class="pin-lbl" style="font-size:' + (rb*1.15) + 'px" x="' + x + '" y="' + cy + '">' + num + "</text>" : "";
  return ring + '<path class="pin tear" d="' + d + '" style="fill:' + fill + '"' + (inter || "") + "><title>" + esc(title || "") + "</title></path>" + numEl;
}
/* Category identity colors — spent on LANE identity (fixed order A/B/C, always
   rendered beside the lane letter + material label, never color alone). */
const CATZ = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)"];
function laneColor(i) { return CATZ[i % 3]; }
function mapCore(pins, zones) {
  const proj = PROJ;
  const land = proj.pathFor(TX_OUTLINE);
  const hwys = TX_HIGHWAYS.map(h => '<path class="hwy" d="' + h.pts.map((p, i) => (i ? "L" : "M") + proj.project(p[0], p[1]).map(n => n.toFixed(1)).join(" ")).join(" ") + '"/>').join("");
  const anchorMark = (x, y, zc) => '<circle class="anchor" style="fill:' + zc + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4"/>';
  const laneChip = (x, y, li, zc) => { const L = "ABCDEFGH"[li] || "?"; return '<circle class="lane-chip-bg" style="fill:' + zc + '" cx="' + x.toFixed(1) + '" cy="' + (y-13).toFixed(1) + '" r="7.5"/><text class="lane-chip-tx" x="' + x.toFixed(1) + '" y="' + (y-13).toFixed(1) + '">' + L + "</text>"; };
  let overlay = "";
  (zones || []).forEach((z, zi) => {
    const li = z.li != null ? z.li : zi, zc = laneColor(li);
    if (z.type === "radius") {
      const p = proj.project(z.anchorLng, z.anchorLat), r = proj.milesToPx(z.radiusMi);
      overlay += '<circle class="radius-fill" style="fill:' + zc + ';stroke:' + zc + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r.toFixed(1) + '"/>' + anchorMark(p[0], p[1], zc) + laneChip(p[0], p[1], li, zc);
    } else if (z.type === "corridor" && z.route) {
      const pts = z.route.map(q => proj.project(q.lng, q.lat));
      const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
      const bw = proj.milesToPx(z.bufferMi) * 2;
      overlay += '<path class="corridor-band" style="stroke:' + zc + ';stroke-width:' + bw.toFixed(1) + 'px" d="' + d + '"/><path class="corridor-line" style="stroke:' + zc + '" d="' + d + '"/>' + pts.map(p => anchorMark(p[0], p[1], zc)).join("") + laneChip(pts[0][0], pts[0][1], li, zc);
    }
  });
  const cityDots = CITIES.map(c => { const p = proj.project(c.lng, c.lat); return '<circle class="city-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="1.8"/><text class="city-lbl" x="' + (p[0]+4.5).toFixed(1) + '" y="' + (p[1]+3).toFixed(1) + '">' + esc(c.name) + "</text>"; }).join("");
  const pinEls = pins.map(p => {
    const q = proj.project(p.lng, p.lat), fill = p.fill || "var(--accent)";
    const inter = p.dot ? ' data-act="openCarrier" data-dot="' + p.dot + '" data-from="' + (p.from||"") + '" style="cursor:pointer"' :
                  p.job ? ' data-act="dashZoomJob" data-id="' + p.job + '" style="cursor:pointer"' : "";
    if (p.shape === "pin") return tearPin(q[0], q[1], p.r || 6, fill, p.num, p.warn, inter, p.title);
    const ring = p.warn ? '<circle class="pin-ring" cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="' + ((p.r||4)+2) + '"/>' : "";
    return ring + '<circle class="pin" cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="' + (p.r||4) + '" style="fill:' + fill + '"' + inter + "><title>" + esc(p.title||"") + "</title></circle>";
  }).join("");
  return '<svg viewBox="0 0 640 520" preserveAspectRatio="xMidYMid meet"><path class="tx-land" d="' + land + '"/>' + hwys + cityDots + overlay + pinEls + "</svg>";
}
function mapTools(id) {
  return '<div class="map-tools"><button data-act="mapZoom" data-id="' + id + '" data-f="1.35" title="Zoom in">' + icon("plus") + '</button><button data-act="mapZoom" data-id="' + id + '" data-f="0.72" title="Zoom out"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg></button><button data-act="mapReset" data-id="' + id + '" title="Reset view">' + icon("target") + "</button></div>";
}
function mapBox(id, pins, zones, extras, h) {
  return '<div class="map" data-mapid="' + id + '" style="height:' + h + 'px">' + mapCore(pins, zones) + mapTools(id) + (extras || "") +
    '<div class="map-note">Preview map — the deployed app uses Google Maps</div></div>';
}
function mapCount(n, label) { return '<div class="map-count"><b id="b-count">' + n + "</b><span>" + (label||"matches") + "</span></div>"; }
function mapLegend(rows) { return '<div class="map-legend">' + rows.map(r => '<div class="lg"><span class="sw" style="background:' + r[0] + '"></span>' + r[1] + "</div>").join("") + "</div>"; }
function builderLegend(zones) {
  const laneRows = (zones || []).map((z, i) => '<div class="lg"><span class="sw" style="background:' + laneColor(i) + ';border-radius:2px"></span><b>' + "ABCDEFGH"[i] + " ·</b> " + esc(z.label || (z.type === "radius" ? z.anchor : z.origin + " → " + z.dest)) + "</div>").join("");
  return '<div class="map-legend">' + laneRows +
    '<div class="lg"><span class="sw" style="background:var(--accent)"></span>Matches filters</div>' +
    '<div class="lg"><span class="sw" style="background:var(--crit)"></span>Has a warning flag</div></div>';
}
function statusLegend(counts) {
  const rows = STATUS_ORDER.map(k => [statusVar(k), STATUS[k].label + (counts ? " · " + counts[k] : "")]);
  if (counts && counts.dnc) rows.push(["var(--st-dnc)", "Do Not Call · " + counts.dnc]);
  return mapLegend(rows);
}
function zoneBBox(zones) {
  const proj = PROJ; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  zones.forEach(z => {
    if (z.type === "radius") { const p = proj.project(z.anchorLng, z.anchorLat), r = proj.milesToPx(z.radiusMi); x0 = Math.min(x0, p[0]-r); x1 = Math.max(x1, p[0]+r); y0 = Math.min(y0, p[1]-r); y1 = Math.max(y1, p[1]+r); }
    else if (z.route) { const b = proj.milesToPx(z.bufferMi); z.route.forEach(q => { const p = proj.project(q.lng, q.lat); x0 = Math.min(x0, p[0]-b); x1 = Math.max(x1, p[0]+b); y0 = Math.min(y0, p[1]-b); y1 = Math.max(y1, p[1]+b); }); }
  });
  return [x0, y0, x1, y1];
}

/* ------------------------------- shell (TNBS chrome) ------------------------------- */
/* Navy 56px bar: white badge + wordmark · global search · Live pill · avatar.
   Below: light 216px sidebar (nav, 11%-navy active) + crumb strip + content. */
function gsearchPop() {
  const q = (state.gsearch || "").trim().toLowerCase();
  if (q.length < 2) return "";
  const cs = DB.carriers.filter(c => c.legal_name.toLowerCase().includes(q) || String(c.dot).includes(q)).slice(0, 5);
  const bs = DB.batches.filter(b => b.name.toLowerCase().includes(q) || (b.customer || "").toLowerCase().includes(q)).slice(0, 3);
  let h = "";
  if (bs.length) h += '<div class="gs-sec">Batches</div>' + bs.map(b => '<button class="gs-row" data-act="openBatch" data-id="' + b.id + '">' + icon("layers") + '<span class="t">' + esc(b.name) + '</span><span class="m">' + esc(b.customer || "") + "</span></button>").join("");
  if (cs.length) h += '<div class="gs-sec">Carriers</div>' + cs.map(c => '<button class="gs-row" data-act="openCarrier" data-dot="' + c.dot + '">' + icon("target") + '<span class="t">' + esc(c.legal_name) + '</span><span class="m">USDOT ' + c.dot + "</span></button>").join("");
  if (!h) h = '<div class="gs-empty">No carriers or batches match &ldquo;' + esc(q) + "&rdquo;</div>";
  return '<div class="gs-pop">' + h + "</div>";
}
function appbar() {
  const u = cur();
  return '<header class="appbar">' +
    '<div class="brand"><div class="mark mark-badge-white" role="img" aria-label="Twisted Nail badge"></div><div><div class="name">Twisted Nail</div><div class="sub">Recruiter</div></div></div>' +
    '<div class="gsearch">' + icon("search") + '<input class="gs-in" id="gs-in" placeholder="Search carriers, batches, USDOT…" value="' + esc(state.gsearch || "") + '" data-live="gSearch" autocomplete="off">' + gsearchPop() + "</div>" +
    '<div class="spacer"></div>' +
    '<span class="pill" title="Shared list — updates live for all users"><span class="dot"></span>Live</span>' +
    '<button class="usercell" data-act="userMenu">' + avatar(u) + '<span class="who"><span class="nm">' + esc(u.name) + '</span><span class="rl">' + ROLE_LABEL[u.role] + "</span></span></button>" +
    "</header>";
}
function sidebar() {
  const u = cur();
  const pend = DB.users.filter(x => (state.overrides.userStatus[x.id]?.status || x.status) === "pending").length;
  const item = (act, to, ic, label, count, on) => '<a data-act="' + act + '"' + (to ? ' data-to="' + to + '"' : "") + ' class="' + (on ? "on" : "") + '">' + icon(ic) + "<span>" + label + "</span>" + (count != null ? '<span class="count">' + count + "</span>" : "") + "</a>";
  const reserved = (ic, label) => '<a class="reserved" data-act="reservedTab" data-label="' + label + '">' + icon(ic) + "<span>" + label + '</span><span class="soon">soon</span></a>';
  return '<aside class="sidebar">' +
    '<nav class="nav">' +
      '<div class="nav-label eyebrow">Recruiting</div>' +
      item("nav", "dashboard", "layers", "Dashboard", DB.batches.length, ["dashboard","workingList"].includes(state.screen)) +
      item("newBatch", null, "search", "New Search", null, state.screen === "builder") +
      '<div class="nav-label eyebrow reserved">Outreach</div>' +
      reserved("mail", "Email") + reserved("message", "Text") + reserved("send", "Mail") + reserved("building", "Enrichment") +
      (u.role === "manager" ? '<div class="nav-label eyebrow">Admin</div>' + item("nav", "users", "users", "Users", pend || null, state.screen === "users") : "") +
    "</nav>" +
    "</aside>";
}
function crumbstrip(crumbs) { return '<div class="crumbstrip"><div class="crumbs">' + crumbs + '</div><div class="spacer"></div></div>'; }
function appShell(inner, crumbs) { return '<div class="shell">' + appbar() + '<div class="body">' + sidebar() + '<div class="main">' + crumbstrip(crumbs) + '<div class="content">' + inner + "</div></div></div></div>"; }
function crumb(items) { return items.map((it, i) => (i ? '<span style="color:var(--text-subtle)">' + icon("chevR") + "</span>" : "") + (it.act ? '<a data-act="' + it.act + '"' + (it.to ? ' data-to="' + it.to + '" data-id="' + it.to + '"' : "") + ' style="cursor:pointer">' + esc(it.label) + "</a>" : '<span class="' + (i === items.length-1 ? "cur" : "") + '">' + esc(it.label) + "</span>")).join(""); }
function sel(a, b) { return a === b ? " selected" : ""; }
function cityOptions(v) { return CITY_NAMES.map(n => '<option value="' + n + '"' + sel(v, n) + ">" + n + ", TX</option>").join(""); }

/* ------------------------------- shared bits ------------------------------- */
function insBadge(c) { const v = c.ins.bipd_on_file; const cls = v >= 1000000 ? "good" : (v >= 500000 ? "warn" : "crit"); return '<span class="badge ' + cls + '">' + fmtMoney(v) + "</span>"; }
function warnChips(dot, stacked) { const w = warnListFor(dot); if (!w.length) return ""; return '<span class="wchips' + (stacked ? " stack" : "") + '">' + w.map(x => '<span class="wchip ' + x.tone + '">' + icon("alert") + esc(x.label) + "</span>").join("") + "</span>"; }
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
function authBrand() { return '<div class="auth-brand"><div class="mark mark-badge-black" role="img" aria-label="Twisted Nail badge"></div><div><div class="name">Twisted Nail</div><div class="sub">Carrier Recruiter</div></div></div>'; }
function screenLogin() {
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<form class="auth-panel" data-submit="signIn"><h1>Sign in</h1>' +
    '<div class="stack gap-16 mt-16"><label class="field"><span class="label">Work email</span><span class="input-group">' + icon("mail") + '<input class="input" type="email" value="hunter@twistednail.com"></span></label>' +
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
    '<form class="auth-panel" data-submit="doRegister"><h1>Create your account</h1>' +
    '<div class="stack gap-16 mt-16"><label class="field"><span class="label">Full name</span><input class="input" value="Cole Ramirez"></label>' +
    '<label class="field"><span class="label">Work email</span><input class="input" type="email" value="cole.r@gmail.com"></label>' +
    '<label class="field"><span class="label">Password</span><input class="input" type="password" value="demo"></label>' +
    '<button class="btn primary lg block" type="submit">Create account</button></div></form>' +
    '<div class="auth-foot">Already have an account? <a class="link" data-act="gotoAuth" data-view="login">Sign in</a></div></div></div>';
}
function screenForgot() {
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<form class="auth-panel" data-submit="doForgot"><h1>Reset password</h1>' +
    '<div class="stack gap-16 mt-16"><label class="field"><span class="label">Work email</span><input class="input" type="email" value="hunter@twistednail.com"></label>' +
    '<button class="btn primary lg block" type="submit">Send reset link</button></div></form>' +
    '<div class="auth-foot"><a class="link" data-act="gotoAuth" data-view="login">Back to sign in</a></div></div></div>';
}
function screenGuest() {
  const u = cur();
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<div class="auth-panel" style="text-align:center"><div style="width:52px;height:52px;border-radius:50%;background:var(--warn-tint);color:var(--warn);display:grid;place-items:center;margin:4px auto 14px">' + icon("clock") + "</div>" +
    "<h1>Account pending approval</h1><p class='lead' style='margin:8px 0 18px'>Thanks, " + esc(u ? u.name.split(" ")[0] : "there") + ". A manager needs to review and provision your account before you can access the recruiting tools.</p>" +
    '<button class="btn block mt-16" data-act="logout">' + icon("logout") + " Sign out</button></div></div></div>";
}

/* ------------------------------- DASHBOARD (F27/F28/F30/F31) ------------------------------- */
function screenDashboard() {
  const totalCarriers = new Set(DB.batchCarriers.map(b => b.dot)).size;
  const interested = DB.batchCarriers.filter(b => effStatus(b.batch_id, b.dot) === "interested" && !effDnc(b.dot)).length;
  const promoted = new Set(DB.batchCarriers.filter(b => effPromoted(b.dot)).map(b => b.dot)).size;
  const withPhone = new Set(DB.batchCarriers.filter(b => { const c = DB.carrierByDot[b.dot]; return c.phone || c.cell; }).map(b => b.dot)).size;
  const strip = statStrip(stat("Active batches", DB.batches.length) + stat("Carriers in play", totalCarriers) + stat("With phone", withPhone) + stat("Interested", interested, "good") + stat("Promoted", promoted, "accent"));

  // F30: map starts EMPTY; jobs toggle on via the legend. Lane colors reset per batch.
  const onJobs = DB.batches.filter(b => state.dashJobs[b.id]);
  const zones = []; onJobs.forEach(b => b.zones.forEach((z, i) => zones.push(Object.assign({}, z, { li: i }))));
  const pins = onJobs.map(b => { const z = b.zones[0]; const p = z.type === "radius" ? { lng:z.anchorLng, lat:z.anchorLat } : { lng:z.originLng, lat:z.originLat }; const bi = DB.batches.indexOf(b); return { lng:p.lng, lat:p.lat, num: bi+1, fill:"var(--accent)", title:b.name, r:8, shape:"pin", job:b.id }; });
  const legend = '<div class="map-legend jobs"><div class="lg" style="font-weight:700;color:var(--text)">Jobs — toggle to show</div>' +
    DB.batches.map((b, bi) => { const on = !!state.dashJobs[b.id]; return '<button class="lg jobrow ' + (on ? "on" : "") + '" data-act="dashToggleJob" data-id="' + b.id + '"><span class="jbox">' + (on ? icon("check") : "") + '</span><span class="mono" style="color:var(--accent-press);font-weight:800">' + (bi+1) + '</span> ' + esc(b.name) + "</button>"; }).join("") +
    (onJobs.length ? '<div class="lg subtle" style="font-size:10.5px">click a pin or name again to zoom</div>' : "") + "</div>";
  const map = mapBox("dash", pins, zones, legend + (onJobs.length === 0 ? '<div class="map-empty">Toggle a job to plot it</div>' : ""), 360);

  // F31: per-stage numeric columns; F40/G15: numerics centered; F39/F41: one thought per line.
  const stageHead = STATUS_ORDER.map(k => '<th class="center" title="' + STATUS[k].label + '"><span class="coldot" style="background:' + statusVar(k) + '"></span>' + ({new:"New",attempted:"Att",contacted:"Con",interested:"Int",not_a_fit:"NaF"}[k]) + "</th>").join("");
  const laneLine = z => z.type === "radius" ? esc(z.anchor.replace(", TX","")) + " · " + z.radiusMi + " mi radius" : esc(z.origin.replace(", TX","")) + " → " + esc(z.dest.replace(", TX","")) + " · " + z.bufferMi + " mi";
  const rows = DB.batches.map((b, bi) => {
    const c = statusCounts(b.id);
    const la = activityForBatch(b.id)[0];
    const stageCells = STATUS_ORDER.map(k => '<td class="center num" style="' + (c[k] ? "" : "color:var(--text-subtle)") + '">' + c[k] + "</td>").join("");
    return '<tr class="clickable" data-act="openBatch" data-id="' + b.id + '">' +
      '<td class="num center" style="width:28px;color:var(--accent);font-weight:800">' + (bi+1) + "</td>" +
      "<td><div class='co oneline'><span class='nm'>" + esc(b.name) + "</span><span class='meta'>" + esc(b.customer) + "</span><span class='meta'>" + esc(b.job) + "</span></div></td>" +
      "<td><div class='lanes-cell'>" + b.zones.map(z => "<div>" + laneLine(z) + "</div>").join("") + "</div></td>" +
      "<td class='center num' style='font-weight:700'>" + c.total + "</td>" + stageCells +
      "<td class='center'>" + (c.dnc ? '<span class="num" style="color:var(--st-dnc);font-weight:700">' + c.dnc + "</span>" : '<span class="subtle">0</span>') + "</td>" +
      "<td>" + (c.warnings ? '<span class="wchip crit">' + icon("alert") + c.warnings + "</span>" : '<span class="subtle">—</span>') + "</td>" +
      "<td class='muted center' style='font-size:12px;white-space:nowrap'>" + (la ? fmtRel(la.at) : "—") + "</td>" +
      '<td class="right"><button class="btn icon ghost sm" data-act="batchMenu" data-id="' + b.id + '">' + icon("dots") + "</button></td></tr>";
  }).join("");
  const table = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="center">#</th><th>Batch</th><th>Lanes</th><th class="center">Carriers</th>' + stageHead + '<th class="center">DNC</th><th>Warn</th><th class="center">Last activity</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>";

  const inner = '<div class="page"><div class="page-head" style="justify-content:center;text-align:center"><div class="h1">Dashboard</div><div class="spacer"></div><button class="btn primary" data-act="newBatch">' + icon("plus") + " New Search</button></div>" +
    strip + '<div class="mt-16">' + map + "</div><div class=\"mt-16\">" + table + "</div></div>";
  return appShell(inner, crumb([{ label:"Dashboard" }]));
}

/* ------------------------------- NEW SEARCH — control panel (F26/G11) ------------------------------- */
function newWizard() {
  return { name:"", customer:"", job:"",
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

/* New Search — Columns layout (owner-selected). Full-width overview map + live
   coverage on top, then three aligned columns with every control visible. */
function screenBuilder() {
  const w = state.wizard;
  const inner = '<div class="page wide" style="padding-bottom:84px">' +
    '<div class="page-head"><div><div class="h1">New Search</div>' +
    '<div class="subtle" style="font-size:13px;margin-top:2px">Define the batch, tune the lanes and freight, and watch the live count — grab it when the numbers look right.</div></div></div>' +
    builderBody(w) + builderFooter(w) + "</div>";
  return appShell(inner, crumb([{ label:"Dashboard", act:"nav", to:"dashboard" }, { label:"New Search" }]));
}
function builderMap(w, h, withCov, extraCls) {
  const s = wizardSearch(w), zones = wizardZones(w), matches = searchMatches(Object.assign({}, s, { zones }));
  const pins = matches.slice(0, 400).map(c => ({ lng:c.lng, lat:c.lat, r:3.5, warn:warningsFor(c).length > 0, title:c.legal_name }));
  let cov = "";
  if (withCov) {
    const wp = matches.filter(c => c.phone || c.cell).length, we = matches.filter(c => c.email).length, t1 = matches.filter(c => c.tier === 1).length;
    cov = '<div class="strip mt-12" id="wiz-cov">' + stat("Matches", matches.length, "accent") + stat("With phone", wp) + stat("With email", we, we ? "" : "crit") + stat("Sand & gravel", t1, "good") + "</div>";
  }
  return '<div class="' + (extraCls || "") + '"><div id="wiz-map-holder" data-h="' + h + '">' + mapBox("builder", pins, zones, mapCount(matches.length) + builderLegend(zones), h) + "</div>" + cov + "</div>";
}
/* Columns body: full-width overview map + live coverage strip on top, then three
   aligned columns — [Details + Lanes] · [Freight] · [Filters] — all visible at once. */
function builderBody(w) {
  return builderMap(w, 430, true, "ns-topmap") +
    '<div class="cols-grid mt-14">' +
      '<div class="stack gap-14">' + panelDetails(w) + panelLanes(w) + "</div>" +
      "<div>" + panelFreight(w) + "</div>" +
      "<div>" + panelFilters(w) + "</div>" +
    "</div>";
}
function panelDetails(w) {
  return '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px">Details</div><div class="stack gap-12">' +
    '<label class="field"><span class="label">Batch name</span><input class="input" style="font-weight:600" placeholder="e.g. Belt Construction Recruitment" value="' + esc(w.name) + '" data-model="wizard.name" id="wz-name"></label>' +
    '<div class="row gap-10"><label class="field grow"><span class="label">Customer</span><input class="input" list="wz-customers" placeholder="Who is this for?" value="' + esc(w.customer) + '" data-model="wizard.customer"><datalist id="wz-customers">' + [...new Set(DB.batches.map(b => b.customer))].map(c => '<option value="' + esc(c) + '">').join("") + "</datalist></label>" +
    '<label class="field grow"><span class="label">Job</span><input class="input" placeholder="What job / project?" value="' + esc(w.job) + '" data-model="wizard.job"></label></div></div></div>';
}
function panelLanes(w) {
  const laneList = w.lanes.length ? w.lanes.map((z, i) => '<div class="lane"><div class="idx" style="background:' + laneColor(i) + ';color:#fff">' + "ABCDEFGH"[i] + '</div><div class="lmeta"><div class="lmat">' + esc(z.label || (z.type === "radius" ? "Radius lane" : "Corridor lane")) + '</div><div class="lgeo">' + (z.type === "radius" ? icon("target") + " " + esc(z.anchor) + " · " + z.radiusMi + " mi" : icon("route") + " " + esc(z.origin) + " → " + esc(z.dest) + " · " + z.bufferMi + " mi") + '</div></div><button class="btn icon ghost sm" data-act="wzEditLane" data-id="' + z.id + '">' + icon("edit") + '</button><button class="btn icon ghost sm" data-act="wzRmLane" data-id="' + z.id + '">' + icon("x") + "</button></div>").join("") : '<div class="subtle" style="font-size:12.5px;padding:4px 0 8px">Add a radius or a corridor — coverage is the union of every lane.</div>';
  return '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px">Lanes <span class="subtle">· ' + w.lanes.length + "</span></div>" + laneList +
    (w.editing ? wizLaneEditor(w) : '<div class="row gap-8 mt-12"><button class="btn sm" data-act="wzAddLane" data-t="radius">' + icon("target") + ' Add radius</button><button class="btn sm" data-act="wzAddLane" data-t="corridor">' + icon("route") + " Add corridor</button></div>") + "</div>";
}
function wizLaneEditor(w) {
  const e = w.editing;
  const anchorSeg = ["pin","address","city","zip","county"].map(t => '<button type="button" class="' + (e.anchorKind === t ? "on" : "") + '" data-act="wzAnchorKind" data-t="' + t + '">' + ({pin:"Pin",address:"Address",city:"City",zip:"ZIP",county:"County"}[t]) + "</button>").join("");
  if (e.type === "radius") {
    return '<div class="lane-editor mt-12"><div class="eyebrow" style="margin-bottom:10px">Radius lane</div><div class="stack gap-12">' +
      '<label class="field"><span class="label">Material / lane label</span><input class="input" placeholder="e.g. Concrete sand — Austin pit" value="' + esc(e.label) + '" data-model="wizard.editing.label"></label>' +
      '<div class="field"><span class="label">Center on</span><div class="seg" style="flex-wrap:wrap;margin-bottom:8px">' + anchorSeg + "</div>" +
      '<select class="select" data-change="wzAnchorCity">' + cityOptions(e.anchor) + "</select></div>" +
      '<div class="field"><div class="row between"><span class="label">Radius</span><span class="label mono" id="wz-r-lbl">' + e.radiusMi + ' mi</span></div><input type="range" min="10" max="150" step="5" value="' + e.radiusMi + '" data-echo="wz-r-lbl" data-echo-fmt="mi" data-live="wzRadius"></div>' +
      '<div class="row gap-8 end"><button class="btn sm" data-act="wzCancelLane">Cancel</button><button class="btn primary sm" data-act="wzSaveLane">' + icon("check") + " Add lane</button></div></div></div>";
  }
  return '<div class="lane-editor mt-12"><div class="eyebrow" style="margin-bottom:10px">Corridor lane <span class="subtle">· custom pickup &amp; dropoff</span></div><div class="stack gap-12">' +
    '<label class="field"><span class="label">Material / lane label</span><input class="input" placeholder="e.g. Crushed limestone — Dallas quarry" value="' + esc(e.label) + '" data-model="wizard.editing.label"></label>' +
    '<div class="row gap-10"><label class="field grow"><span class="label">Pickup</span><select class="select" data-change="wzOrigin">' + cityOptions(e.origin) + "</select></label>" + icon("arrowR") + '<label class="field grow"><span class="label">Dropoff</span><select class="select" data-change="wzDest">' + cityOptions(e.dest) + "</select></label></div>" +
    '<div class="field"><div class="row between"><span class="label">Within</span><span class="label mono" id="wz-b-lbl">' + e.bufferMi + ' mi</span></div><input type="range" min="10" max="80" step="5" value="' + e.bufferMi + '" data-echo="wz-b-lbl" data-echo-fmt="mi" data-live="wzBuffer"><div class="subtle" style="font-size:11px;margin-top:4px">Distance from <b>any point</b> along the run.</div></div>' +
    '<div class="row gap-8 end"><button class="btn sm" data-act="wzCancelLane">Cancel</button><button class="btn primary sm" data-act="wzSaveLane">' + icon("check") + " Add lane</button></div></div></div>";
}
function panelFreight(w) {
  const s = wizardSearch(w), zones = wizardZones(w);
  const scope = Object.assign({}, s, { zones, cargo: null });
  const scopeMatches = searchMatches(scope);
  const flagCount = f => scopeMatches.filter(c => c.cargoFlags.includes(f)).length;
  const flags = DB.CARGO_FLAGS.map(f => '<label class="flag-row"><input type="checkbox" class="hide" ' + (w.cargo.flags.includes(f) ? "checked" : "") + ' data-change="wzFlag" data-f="' + esc(f) + '"><span class="box" style="width:16px;height:16px;border-radius:4px;border:1.5px solid var(--border-strong);display:grid;place-items:center;flex:none;' + (w.cargo.flags.includes(f) ? "background:var(--accent);border-color:var(--accent)" : "") + '">' + (w.cargo.flags.includes(f) ? '<span style="color:#fff;display:grid">' + icon("check") + "</span>" : "") + '</span><span>' + esc(f) + '</span><span class="cnt">' + flagCount(f) + "</span></label>").join("");
  const q = (w.cargo.q || "").toLowerCase();
  const otherScope = DB.cargoOtherValues.map(v => ({ v: v.value, group: v.group, count: scopeMatches.filter(c => c.cargo_other_norm === v.value).length })).filter(v => v.count > 0 && (!q || v.v.toLowerCase().includes(q)));
  const inc = w.cargo.other.include, exc = w.cargo.other.exclude;
  const rows = otherScope.map(v => { const isI = inc.includes(v.v), isE = exc.includes(v.v); return '<div class="facet-row ' + (isI ? "inc" : isE ? "exc" : "") + '"><span class="fval">' + esc(v.v) + '</span><span class="cnt">' + v.count + '</span><span class="tri"><button class="inc' + (isI ? " on" : "") + '" data-act="wzOther" data-v="' + esc(v.v) + '" data-m="inc" title="Include">' + icon("plus") + '</button><button class="exc' + (isE ? " on" : "") + '" data-act="wzOther" data-v="' + esc(v.v) + '" data-m="exc" title="Exclude">' + icon("x") + "</button></span></div>"; }).join("");
  const groups = {}; DB.cargoOtherValues.forEach(v => { if (v.group) groups[v.group] = (groups[v.group]||0) + scopeMatches.filter(c => c.cargo_other_norm === v.value).length; });
  const sug = Object.keys(groups).filter(g => groups[g] > 0).sort((a,b) => groups[b]-groups[a]).map(g => '<span class="chip sugbar-chip" data-act="wzSuggest" data-g="' + esc(g) + '">' + esc(g) + ' <span class="cnt">' + groups[g] + "</span></span>").join("");
  return '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px">Freight — cargo categories</div><div class="cargo-flags">' + flags + "</div>" +
    '<div class="row between center" style="margin:14px 0 8px"><div class="eyebrow">"Other" cargo — the sand &amp; gravel signal</div><label class="switch"><input type="checkbox" ' + (w.cargo.other.enabled ? "checked" : "") + ' data-change="wzOtherEnabled"><span class="track"></span></label></div>' +
    (w.cargo.other.enabled ? '<span class="input-group" style="max-width:100%;margin-bottom:10px">' + icon("search") + '<input class="input" id="wz-osearch" placeholder="Search Other values…" value="' + esc(w.cargo.q||"") + '" data-live="wzOtherSearch"></span>' +
      '<div class="sugbar" style="margin-bottom:10px">' + (sug || '<span class="subtle">no matches in scope</span>') + "</div>" +
      '<div class="facet-list" id="wz-facets" style="max-height:220px">' + (rows || '<div class="facet-row"><span class="subtle">No Other values match this scope.</span></div>') + "</div>" +
      '<div class="facet-sum mt-12">' + icon("filter") + " Including <b>" + inc.length + "</b> values · Excluding <b>" + exc.length + "</b></div>"
      : '<div class="subtle" style="font-size:12.5px">Enable to browse the free-text values sand &amp; gravel carriers actually use.</div>') + "</div>";
}
function panelFilters(w) {
  const f = w.filters;
  const tog = (label, key) => '<label class="switch" style="justify-content:space-between;width:100%"><span class="label">' + label + '</span><span style="position:relative;display:inline-flex"><input type="checkbox" ' + (f[key] ? "checked" : "") + ' data-change="wzFilter" data-k="' + key + '"><span class="track"></span></span></label>';
  return '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:12px">Carrier filters</div><div class="stack gap-12">' +
    '<div class="field"><span class="label">Minimum insurance (BIPD)</span><select class="select" data-change="wzInsurance"><option value="0"' + sel(""+f.insuranceMin,"0") + '>Any</option><option value="500000"' + sel(""+f.insuranceMin,"500000") + '>$500 K+</option><option value="750000"' + sel(""+f.insuranceMin,"750000") + '>$750 K+</option><option value="1000000"' + sel(""+f.insuranceMin,"1000000") + '>$1.0 MM+</option><option value="2000000"' + sel(""+f.insuranceMin,"2000000") + '>$2.0 MM+</option></select>' +
    '<label class="switch mt-8" style="' + (f.insuranceMin ? "" : "opacity:.45;pointer-events:none") + '"><input type="checkbox" ' + (f.keepBelow ? "checked" : "") + ' data-change="wzKeepBelow"><span class="track"></span><span class="label">Keep below-threshold carriers visible</span></label></div>' +
    '<div class="field"><span class="label">Fleet size</span><select class="select" data-change="wzSize"><option value="any"' + sel(f.size,"any") + '>Any size</option><option value="small"' + sel(f.size,"small") + '>1–5 trucks</option><option value="mid"' + sel(f.size,"mid") + '>6–20 trucks</option><option value="large"' + sel(f.size,"large") + '>21+ trucks</option></select></div>' +
    tog("For-hire only","forHire") + tog("Active registration only","activeOnly") + tog("Authorized &amp; insured only","authorizedOnly") + tog("Interstate only","interstateOnly") +
    '<div class="divider" style="margin:4px 0"></div><div class="eyebrow">Contactability</div>' + tog("Has phone on file","hasPhone") + tog("Has email on file","hasEmail") +
    '<div class="demo-note" style="margin-top:6px">' + icon("alert") + ' Safety &amp; insurance issues are never filtered out — carriers with issues are highlighted in red everywhere.</div>' +
    "</div></div>";
}
function builderFooter(w) {
  const matches = searchMatches(wizardSearch(w)), n = matches.length;
  return '<div class="wizfoot"><span class="wizcount"><b id="b-foot-count">' + n + '</b> carriers match</span><div class="spacer" style="flex:1"></div>' +
    '<button class="btn" data-act="nav" data-to="dashboard">Cancel</button>' +
    '<button class="btn primary lg" data-act="wzGrab">' + icon("layers") + ' Grab Batch — <span id="wz-grab-n">' + n + "</span></button></div>";
}

const SCREENS = {
  login: screenLogin, register: screenRegister, forgot: screenForgot, guest: screenGuest,
  dashboard: screenDashboard, builder: screenBuilder, workingList: screenWorkingList,
  profile: screenProfile, users: screenUsers
};
