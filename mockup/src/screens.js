/* ============================================================================
   screens.js — screen renderers, Texas map, shared components, modals, menus,
   and screen-specific action handlers.
   ============================================================================ */

/* ------------------------------- map ------------------------------- */
const PRESET_ROUTES = {
  aus_sat: { label:"Austin → San Antonio", route:[{lng:-97.74,lat:30.27},{lng:-98.10,lat:29.89},{lng:-98.49,lat:29.42}] },
  dal_ftw: { label:"Dallas → Fort Worth",  route:[{lng:-96.80,lat:32.78},{lng:-97.05,lat:32.76},{lng:-97.33,lat:32.75}] },
  hou_cc:  { label:"Houston → Corpus Christi", route:[{lng:-95.37,lat:29.76},{lng:-96.40,lat:28.98},{lng:-97.40,lat:27.80}] },
  mid_od:  { label:"Midland → Odessa",     route:[{lng:-102.08,lat:32.00},{lng:-102.37,lat:31.85}] }
};
function statusVar(s) { return "var(--st-" + ({ not_a_fit:"notfit" }[s] || s) + ")"; }

function mapCore(pins, geo) {
  const W = 640, H = 520, proj = makeProjection(W, H, 16);
  const land = proj.pathFor(TX_OUTLINE);
  const anchorMark = (x, y) => '<circle class="anchor" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5"/>';
  let overlay = "";
  if (geo && geo.mode === "radius") {
    const p = proj.project(geo.anchorLng, geo.anchorLat), r = proj.milesToPx(geo.radiusMi);
    overlay = '<circle class="radius-fill" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r.toFixed(1) + '"/>' + anchorMark(p[0], p[1]);
  } else if (geo && geo.mode === "corridor") {
    const pts = geo.route.map(q => proj.project(q.lng, q.lat));
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const bw = proj.milesToPx(geo.bufferMi) * 2;
    overlay = '<path class="corridor-band" style="stroke-width:' + bw.toFixed(1) + 'px" d="' + d + '"/>' +
              '<path class="corridor-line" d="' + d + '"/>' + pts.map(p => anchorMark(p[0], p[1])).join("");
  }
  const cityDots = CITIES.filter(c => c.major).map(c => {
    const p = proj.project(c.lng, c.lat);
    return '<circle class="city-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2"/>' +
           '<text class="city-lbl" x="' + (p[0]+5).toFixed(1) + '" y="' + (p[1]+3).toFixed(1) + '">' + esc(c.name) + "</text>";
  }).join("");
  const pinEls = pins.map(p => {
    const q = proj.project(p.lng, p.lat);
    const style = p.fill ? ' style="fill:' + p.fill + '"' : "";
    const inter = p.dot ? ' data-act="openCarrier" data-dot="' + p.dot + '" data-from="' + (p.from || "") + '" style="cursor:pointer' + (p.fill ? ";fill:" + p.fill : "") + '"' : style;
    return '<circle class="pin ' + (p.cls || "") + '" cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="' + (p.r || 4) + '"' + inter + "><title>" + esc(p.title || "") + "</title></circle>";
  }).join("");
  return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">' +
    '<path class="tx-land" d="' + land + '"/>' + cityDots + overlay + pinEls + "</svg>";
}

/* ------------------------------- shell ------------------------------- */
function sidebar() {
  const u = cur();
  const onDash = ["dashboard","workingList"].includes(state.screen);
  const item = (act, to, ic, label, count, on) =>
    '<a data-act="' + act + '"' + (to ? ' data-to="' + to + '"' : "") + ' class="' + (on ? "on" : "") + '">' +
      icon(ic) + "<span>" + label + "</span>" + (count != null ? '<span class="count">' + count + "</span>" : "") + "</a>";
  return '<aside class="sidebar">' +
    '<div class="brand"><div class="mark">' + icon("truck") + '</div><div><div class="name">Twisted Nail</div><div class="sub">Recruiter</div></div></div>' +
    '<nav class="nav">' +
      '<div class="nav-label eyebrow">Recruiting</div>' +
      item("nav", "dashboard", "layers", "Batches", DB.batches.length, onDash) +
      item("newBatch", null, "search", "New Search", null, state.screen === "builder") +
      (u.role === "manager" ? '<div class="nav-label eyebrow">Admin</div>' + item("nav", "users", "users", "Users", DB.users.filter(x => (state.overrides.userStatus[x.id]?.status || x.status) === "pending").length || null, state.screen === "users") : "") +
    "</nav>" +
    '<div class="side-foot"><button class="usercell" data-act="userMenu">' + avatar(u) +
      '<span class="who"><span class="nm">' + esc(u.name) + '</span><span class="rl">' + ROLE_LABEL[u.role] + "</span></span>" +
      '<span style="margin-left:auto;color:var(--text-subtle)">' + icon("chevD") + "</span></button></div>" +
    "</aside>";
}
function topbar(crumbs) {
  return '<header class="topbar"><div class="crumbs">' + crumbs + '</div><div class="spacer"></div>' +
    '<span class="badge good" title="Shared list — updates live for all users"><span class="dot"></span>Live</span>' +
    '<button class="btn icon ghost" data-act="toggleTheme" title="Toggle theme">' + icon("sun") + "</button>" +
    "</header>";
}
function appShell(inner, crumbs) {
  return '<div class="shell">' + sidebar() + '<div class="main">' + topbar(crumbs) + '<div class="content">' + inner + "</div></div></div>";
}
function crumb(items) {
  return items.map((it, i) => (i ? '<span style="color:var(--text-subtle)">' + icon("chevR", "") + "</span>" : "") +
    (it.act ? '<a data-act="' + it.act + '"' + (it.to ? ' data-to="' + it.to + '"' : "") + ' style="cursor:pointer">' + esc(it.label) + "</a>"
            : '<span class="' + (i === items.length - 1 ? "cur" : "") + '">' + esc(it.label) + "</span>")).join("");
}

/* ------------------------------- AUTH ------------------------------- */
function authBrand() {
  return '<div class="auth-brand"><div class="mark">' + icon("truck") + '</div><div><div class="name">Twisted Nail</div><div class="sub">Carrier Recruiter</div></div></div>';
}
function screenLogin() {
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<form class="auth-panel" data-submit="signIn">' +
      "<h1>Sign in</h1><p class='lead'>Recruit sand &amp; gravel carriers across Texas.</p>" +
      '<div class="stack gap-16">' +
        '<label class="field"><span class="label">Work email</span><span class="input-group">' + icon("mail") + '<input class="input" type="email" value="hunter@twistednail.com" autocomplete="username"></span></label>' +
        '<label class="field"><span class="label">Password</span><span class="input-group">' + icon("lock") + '<input class="input" type="password" value="demo" autocomplete="current-password"></span></label>' +
        '<div class="auth-row"><label class="check"><input type="checkbox" checked><span class="box">' + icon("check") + '</span><span>Remember me</span></label>' +
          '<a class="link" data-act="gotoAuth" data-view="forgot">Forgot password?</a></div>' +
        '<button class="btn primary lg block" type="submit">Sign in</button>' +
      "</div>" +
      '<div class="demo-note"><b>Prototype — sign in as any role:</b><div class="row wrap gap-6 mt-8">' +
        DB.users.filter(u => u.status === "approved").map(u => '<button type="button" class="btn sm" data-act="demoLogin" data-uid="' + u.id + '">' + esc(u.name.split(" ")[0]) + " · " + ROLE_LABEL[u.role] + "</button>").join("") +
        '<button type="button" class="btn sm" data-act="demoLogin" data-uid="u_guest1">New guest</button>' +
      "</div></div>" +
    "</form>" +
    '<div class="auth-foot">New to the team? <a class="link" data-act="gotoAuth" data-view="register">Create an account</a></div>' +
    "</div></div>";
}
function screenRegister() {
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<form class="auth-panel" data-submit="doRegister">' +
      "<h1>Create your account</h1><p class='lead'>New accounts start as a guest until a manager approves them.</p>" +
      '<div class="stack gap-16">' +
        '<label class="field"><span class="label">Full name</span><input class="input" value="Cole Ramirez"></label>' +
        '<label class="field"><span class="label">Work email</span><input class="input" type="email" value="cole.r@gmail.com"></label>' +
        '<label class="field"><span class="label">Password</span><input class="input" type="password" value="demo"></label>' +
        '<button class="btn primary lg block" type="submit">Create account</button>' +
      "</div>" +
    "</form>" +
    '<div class="auth-foot">Already have an account? <a class="link" data-act="gotoAuth" data-view="login">Sign in</a></div>' +
    "</div></div>";
}
function screenForgot() {
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<form class="auth-panel" data-submit="doForgot">' +
      "<h1>Reset password</h1><p class='lead'>We'll email you a reset link.</p>" +
      '<div class="stack gap-16"><label class="field"><span class="label">Work email</span><input class="input" type="email" value="hunter@twistednail.com"></label>' +
      '<button class="btn primary lg block" type="submit">Send reset link</button></div>' +
    "</form>" +
    '<div class="auth-foot"><a class="link" data-act="gotoAuth" data-view="login">Back to sign in</a></div>' +
    "</div></div>";
}
function screenGuest() {
  const u = cur();
  return '<div class="auth"><div class="auth-card">' + authBrand() +
    '<div class="auth-panel" style="text-align:center">' +
      '<div style="width:52px;height:52px;border-radius:50%;background:var(--warn-tint);color:var(--warn);display:grid;place-items:center;margin:4px auto 14px">' + icon("clock") + "</div>" +
      "<h1>Account pending approval</h1>" +
      "<p class='lead' style='margin-bottom:18px'>Thanks, " + esc(u ? u.name.split(" ")[0] : "there") + ". A manager needs to review and provision your account before you can access the recruiting tools. You'll get an email when you're in.</p>" +
      '<div class="demo-note" style="text-align:left"><b>What you\'ll get access to:</b> the carrier database, search batches, and the call workflow — once a manager assigns your role (Editor or Viewer).</div>' +
      '<button class="btn block mt-16" data-act="logout">' + icon("logout") + " Sign out</button>" +
    "</div>" +
    '<div class="auth-foot subtle">Guests only see this page until approved — that\'s the role gate in action.</div>' +
    "</div></div>";
}

/* ------------------------------- DASHBOARD ------------------------------- */
function screenDashboard() {
  const cards = DB.batches.map(batchCard).join("");
  const totalCarriers = new Set(DB.batchCarriers.map(b => b.dot)).size;
  const inner = '<div class="page">' +
    '<div class="page-head"><div><div class="h1">Recruiting Batches</div><div class="desc">Each batch is a saved search and an independent working session. Grab a batch of trucks, then work the shared call list.</div></div>' +
      '<div class="spacer"></div><button class="btn primary" data-act="newBatch">' + icon("plus") + " New Search</button></div>" +
    '<div class="stat-row mt-4" style="margin-bottom:20px">' +
      stat("Active batches", DB.batches.length) +
      stat("Carriers in play", totalCarriers) +
      stat("Interested", DB.batchCarriers.filter(b => effStatus(b.batch_id, b.dot) === "interested" && !effDnc(b.dot)).length) +
      stat("Sent to onboarding", DB.batchCarriers.filter(b => b.onboarded_at || state.overrides.onboarded[b.dot]).length) +
    "</div>" +
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px">' + cards + "</div>" +
    "</div>";
  return appShell(inner, crumb([{ label:"Batches" }]));
}
function stat(k, v, sub) { return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + (sub ? " <small>" + sub + "</small>" : "") + "</div></div>"; }
function batchCard(b) {
  const c = statusCounts(b.id), total = batchMembers(b.id).length;
  const seg = (k, cls) => c[k] ? '<i style="width:' + (c[k]/total*100) + '%;background:' + statusVar(k) + '"></i>' : "";
  const geo = b.search.geo;
  const geoLabel = geo.mode === "radius" ? geo.anchor + " · " + geo.radiusMi + " mi" : geo.label + " · " + geo.bufferMi + " mi";
  const creator = DB.userById[b.created_by];
  return '<div class="card" style="padding:16px;cursor:pointer" data-act="openBatch" data-id="' + b.id + '">' +
    '<div class="row between" style="align-items:flex-start"><div style="min-width:0"><div style="font-weight:800;font-size:15px">' + esc(b.name) + "</div>" +
      '<div class="row gap-6 mt-4 muted" style="font-size:12px">' + icon(geo.mode === "radius" ? "target" : "route", "") + "<span style='white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>" + esc(geoLabel) + "</span></div></div>" +
      '<button class="btn icon ghost sm" data-act="batchMenu" data-id="' + b.id + '" style="flex:none">' + icon("dots") + "</button></div>" +
    '<div class="row between mt-16" style="align-items:flex-end"><div><div class="eyebrow">Carriers</div><div class="mono" style="font-size:24px;font-weight:800">' + total + "</div></div>" +
      '<div style="text-align:right"><div class="eyebrow">Interested</div><div class="mono" style="font-size:24px;font-weight:800;color:var(--st-interested)">' + c.interested + "</div></div></div>" +
    '<div class="progress mt-12">' + STATUS_ORDER.map(k => seg(k)).join("") + (c.dnc ? '<i style="width:' + (c.dnc/total*100) + '%;background:var(--st-dnc)"></i>' : "") + "</div>" +
    '<div class="row between mt-12 subtle" style="font-size:11.5px">' +
      "<span>by " + esc(creator.name.split(" ")[0]) + "</span>" +
      '<span class="row gap-6">' + (b.new_since ? '<span class="badge good" style="height:18px">+' + b.new_since + " new</span>" : "") + "refreshed " + fmtRel(b.last_refreshed) + "</span></div>" +
    "</div>";
}

/* ------------------------------- SEARCH BUILDER ------------------------------- */
function newBuilder() {
  const a = cityOf("Austin");
  return { name:"", geoMode:"radius", anchorType:"city", anchorCity:"Austin", anchorLng:a.lng, anchorLat:a.lat, radiusMi:50,
    routeKey:"aus_sat", bufferMi:40, wideNet:true, matchTerms:["Sand & Gravel","Rock","Dirt","Aggregate"],
    forHire:true, size:"any", insuranceMin:0, keepBelow:true, activeOnly:true, authorizedOnly:false, interstateOnly:false, excludeSafety:false };
}
const SIZE_RANGES = { any:[null,null], small:[1,5], mid:[6,20], large:[21,999] };
function builderSearch(b) {
  const geo = b.geoMode === "radius"
    ? { mode:"radius", anchor:b.anchorCity + ", TX", anchorLng:b.anchorLng, anchorLat:b.anchorLat, radiusMi:+b.radiusMi }
    : { mode:"corridor", label:PRESET_ROUTES[b.routeKey].label, route:PRESET_ROUTES[b.routeKey].route, bufferMi:+b.bufferMi };
  const sz = SIZE_RANGES[b.size];
  return { geo, cargo:{ wideNet:b.wideNet }, forHire:b.forHire, sizeMin:sz[0], sizeMax:sz[1],
    insuranceMin:+b.insuranceMin, keepBelow:b.keepBelow, activeOnly:b.activeOnly, authorizedOnly:b.authorizedOnly,
    interstateOnly:b.interstateOnly, excludeSafety:b.excludeSafety };
}
function builderPins(search, matchesSet) {
  return DB.carriers.map(c => matchesSet.has(c) ? { lng:c.lng, lat:c.lat, cls:"match", r:4, title:c.legal_name }
                                                : { lng:c.lng, lat:c.lat, cls:"dim", r:2.5 });
}
function screenBuilder() {
  const b = state.builder, s = builderSearch(b), matches = searchMatches(s), mset = new Set(matches);
  const inner = '<div class="page wide" style="padding:20px 24px 90px">' +
    '<div class="page-head"><div><div class="h1">New Search</div><div class="desc">Define a geography and filters, watch the match count update live, then grab the batch.</div></div></div>' +
    '<div style="display:grid;grid-template-columns:340px 1fr;gap:18px;align-items:start">' +
      builderFilters(b) +
      '<div class="stack gap-16">' +
        '<div class="map" style="height:440px" id="b-map">' + mapCore(builderPins(s, mset), s.geo) + mapCount(matches.length) + mapLegend(true) + "</div>" +
        '<div id="b-preview">' + builderPreview(matches) + "</div>" +
      "</div>" +
    "</div>" +
    builderFooter(b, matches.length) +
    "</div>";
  return appShell(inner, crumb([{ label:"Batches", act:"nav", to:"dashboard" }, { label:"New Search" }]));
}
function mapCount(n) { return '<div class="map-count"><b id="b-count">' + n + "</b><span>matches</span></div>"; }
function mapLegend(build) {
  const rows = build
    ? [["var(--accent)","Matches your filters"],["var(--map-line)","Other carriers"]]
    : STATUS_ORDER.map(k => [statusVar(k), STATUS[k].label]);
  return '<div class="map-legend">' + rows.map(r => '<div class="lg"><span class="sw" style="background:' + r[0] + '"></span>' + r[1] + "</div>").join("") + "</div>";
}
function fieldRow(label, control) { return '<div class="field"><span class="label">' + label + "</span>" + control + "</div>"; }
function builderFilters(b) {
  const cityOpts = CITIES.map(c => '<option value="' + c.name + '"' + (c.name === b.anchorCity ? " selected" : "") + ">" + c.name + ", TX</option>").join("");
  const routeOpts = Object.keys(PRESET_ROUTES).map(k => '<option value="' + k + '"' + (k === b.routeKey ? " selected" : "") + ">" + PRESET_ROUTES[k].label + "</option>").join("");
  const anchorSeg = ["address","pin","city","zip","county"].map(t => '<button type="button" class="' + (b.anchorType === t ? "on" : "") + '" data-act="bAnchorType" data-t="' + t + '">' + ({address:"Address",pin:"Pin",city:"City",zip:"ZIP",county:"County"}[t]) + "</button>").join("");
  return '<div class="stack gap-16">' +
    // geography
    '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:12px">Geography</div>' +
      '<div class="seg" style="width:100%;margin-bottom:14px">' +
        '<button type="button" style="flex:1;justify-content:center" class="' + (b.geoMode === "radius" ? "on" : "") + '" data-act="bMode" data-m="radius">' + icon("target") + "Radius</button>" +
        '<button type="button" style="flex:1;justify-content:center" class="' + (b.geoMode === "corridor" ? "on" : "") + '" data-act="bMode" data-m="corridor">' + icon("route") + "Corridor</button>" +
      "</div>" +
      (b.geoMode === "radius"
        ? '<div class="stack gap-12"><div class="seg" style="flex-wrap:wrap">' + anchorSeg + "</div>" +
            fieldRow("Center on", '<select class="select" data-change="bAnchorCity">' + cityOpts + "</select>") +
            '<div class="field"><div class="row between"><span class="label">Radius</span><span class="label mono" id="b-radius-lbl">' + b.radiusMi + ' mi</span></div>' +
              '<input type="range" min="10" max="150" step="5" value="' + b.radiusMi + '" data-echo="b-radius-lbl" data-echo-fmt="mi" data-live="bRadius"></div></div>'
        : '<div class="stack gap-12">' + fieldRow("Route", '<select class="select" data-change="bRoute">' + routeOpts + "</select>") +
            '<div class="field"><div class="row between"><span class="label">Within</span><span class="label mono" id="b-buffer-lbl">' + b.bufferMi + ' mi</span></div>' +
              '<input type="range" min="10" max="80" step="5" value="' + b.bufferMi + '" data-echo="b-buffer-lbl" data-echo-fmt="mi" data-live="bBuffer">' +
              '<div class="subtle mt-4" style="font-size:11.5px">Distance from <b>any point</b> along the run — not just the endpoints.</div></div></div>') +
    "</div>" +
    // cargo
    '<div class="card" style="padding:16px"><div class="row between" style="margin-bottom:10px"><div class="eyebrow">Freight — sand &amp; gravel</div>' + badge2("tier1", "Tier 1") + "</div>" +
      '<div class="subtle" style="font-size:12px;margin-bottom:10px">Match the free-text "Other" cargo field for these terms:</div>' +
      '<div class="row wrap gap-6" id="b-terms">' + b.matchTerms.map((t, i) => '<span class="chip">' + esc(t) + '<button data-act="bRmTerm" data-i="' + i + '">' + icon("x") + "</button></span>").join("") +
        '<input class="input" style="width:120px;height:26px" placeholder="+ add term" data-keyadd="bAddTerm" id="b-term-input"></div>' +
      '<label class="check mt-16"><input type="checkbox" ' + (b.wideNet ? "checked" : "") + ' data-change="bWideNet"><span class="box">' + icon("check") + '</span><span>Wide net — also include Dry Bulk / Construction / Building Materials flags <span class="subtle">(Tier 2)</span></span></label>' +
    "</div>" +
    // carrier filters
    '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:12px">Carrier filters</div><div class="stack gap-12">' +
      fieldRow("Fleet size", '<select class="select" data-change="bSize"><option value="any"' + sel(b.size,"any") + ">Any size</option><option value=\"small\"" + sel(b.size,"small") + ">1–5 trucks</option><option value=\"mid\"" + sel(b.size,"mid") + ">6–20 trucks</option><option value=\"large\"" + sel(b.size,"large") + ">21+ trucks</option></select>") +
      '<div class="field"><span class="label">Minimum insurance (BIPD)</span>' +
        '<select class="select" data-change="bInsurance"><option value="0"' + sel(""+b.insuranceMin,"0") + ">Any</option><option value=\"500000\"" + sel(""+b.insuranceMin,"500000") + ">$500K+</option><option value=\"750000\"" + sel(""+b.insuranceMin,"750000") + ">$750K+</option><option value=\"1000000\"" + sel(""+b.insuranceMin,"1000000") + ">$1MM+</option><option value=\"2000000\"" + sel(""+b.insuranceMin,"2000000") + ">$2MM+</option></select>" +
        '<label class="switch mt-8" style="' + (b.insuranceMin ? "" : "opacity:.45;pointer-events:none") + '"><input type="checkbox" ' + (b.keepBelow ? "checked" : "") + ' data-change="bKeepBelow"><span class="track"></span><span class="label">Keep below-threshold carriers visible</span></label></div>' +
      '<div class="stack gap-8 mt-4">' +
        toggleRow("For-hire only", "bForHire", b.forHire) +
        toggleRow("Active registration only", "bActive", b.activeOnly) +
        toggleRow("Authorized &amp; insured only", "bAuth", b.authorizedOnly) +
        toggleRow("Interstate only", "bInterstate", b.interstateOnly) +
        toggleRow("Exclude concerning safety", "bSafety", b.excludeSafety) +
      "</div>" +
    "</div></div></div>";
}
function badge2(cls, label) { return '<span class="badge ' + cls + '">' + label + "</span>"; }
function sel(a, b) { return a === b ? " selected" : ""; }
function toggleRow(label, act, on) {
  return '<label class="switch" style="justify-content:space-between;width:100%"><span class="label">' + label + '</span><span style="position:relative;display:inline-flex"><input type="checkbox" ' + (on ? "checked" : "") + ' data-change="' + act + '"><span class="track"></span></span></label>';
}
function builderPreview(matches) {
  if (!matches.length) return '<div class="card empty">' + icon("search") + "<div>No carriers match — loosen a filter.</div></div>";
  const rows = matches.slice(0, 8).map(c =>
    "<tr><td><div class='co'><span class='nm'>" + esc(c.legal_name) + "</span><span class='meta'>" + esc(c.city) + ", TX · " + tierTag(c.tier) + "</span></div></td>" +
    "<td class='mono'>" + c.power_units + "</td><td>" + insBadge(c) + "</td><td class='mono muted'>" + esc(c.cargoOther || c.cargoFlags[0] || "—") + "</td></tr>").join("");
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Carrier</th><th>Trucks</th><th>Insurance</th><th>Cargo signal</th></tr></thead><tbody>' + rows + "</tbody></table>" +
    (matches.length > 8 ? '<div class="subtle" style="padding:10px 12px;font-size:12px">+ ' + (matches.length - 8) + " more will be captured in the batch</div>" : "") + "</div>";
}
function tierTag(t) { return t === 1 ? "Tier 1 match" : (t === 2 ? "Tier 2" : "no match"); }
function insBadge(c) {
  const v = c.ins.bipd_on_file;
  const cls = v >= 1000000 ? "good" : (v >= 500000 ? "warn" : "plain");
  return '<span class="badge ' + cls + '">' + fmtMoney(v) + "</span>";
}
function builderFooter(b, n) {
  return '<div style="position:fixed;left:var(--sidebar-w);right:0;bottom:0;background:var(--surface);border-top:1px solid var(--border);padding:12px 24px;display:flex;gap:14px;align-items:center;box-shadow:var(--shadow-2);z-index:20">' +
    '<input class="input" style="max-width:340px" placeholder="Name this batch — e.g. Belt Construction Recruitment" value="' + esc(b.name) + '" data-model="builder.name" id="b-name">' +
    '<div class="muted" style="font-size:13px"><b class="mono" style="color:var(--text)" id="b-foot-count">' + n + '</b> carriers will be grabbed into this batch</div>' +
    '<div class="spacer" style="flex:1"></div>' +
    '<button class="btn" data-act="nav" data-to="dashboard">Cancel</button>' +
    '<button class="btn primary lg" data-act="grabBatch">' + icon("layers") + " Grab Batch</button></div>";
}

/* ------------------------------- WORKING LIST ------------------------------- */
function distanceFor(c, geo) {
  if (!geo) return null;
  return geo.mode === "radius" ? haversineMiles(c.lng, c.lat, geo.anchorLng, geo.anchorLat) : pointToRouteMiles(c.lng, c.lat, geo.route);
}
function workingRows(batchId) {
  const b = DB.batches.find(x => x.id === batchId), geo = b.search.geo, f = state.list;
  let rows = batchMembers(batchId).map(m => {
    const c = DB.carrierByDot[m.dot];
    return { c, dnc: effDnc(m.dot), status: effStatus(batchId, m.dot), dist: distanceFor(c, geo), logs: logsForDot(m.dot) };
  });
  if (f.status !== "all") rows = rows.filter(r => f.status === "dnc" ? r.dnc : (!r.dnc && r.status === f.status));
  if (f.q) { const q = f.q.toLowerCase(); rows = rows.filter(r => r.c.legal_name.toLowerCase().includes(q) || String(r.c.dot).includes(q) || r.c.city.toLowerCase().includes(q)); }
  if (f.insurance !== "any") { const min = +f.insurance; rows = rows.filter(r => r.c.ins.bipd_on_file >= min); }
  if (f.size !== "any") { const [lo, hi] = SIZE_RANGES[f.size]; rows = rows.filter(r => (lo == null || r.c.power_units >= lo) && (hi == null || r.c.power_units <= hi)); }
  rows.sort((a, z) => f.sort === "distance" ? (a.dist||0) - (z.dist||0) : f.sort === "size" ? z.c.power_units - a.c.power_units :
    f.sort === "recent" ? (z.logs[0]?.at||0) - (a.logs[0]?.at||0) : a.c.legal_name.localeCompare(z.c.legal_name));
  return rows;
}
function screenWorkingList() {
  const b = DB.batches.find(x => x.id === state.activeBatchId);
  if (!b) { state.screen = "dashboard"; return screenDashboard(); }
  const rows = workingRows(b.id), counts = statusCounts(b.id), total = batchMembers(b.id).length;
  const geo = b.search.geo;
  const geoLabel = geo.mode === "radius" ? geo.anchor + " · " + geo.radiusMi + " mi radius" : geo.label + " · " + geo.bufferMi + " mi corridor";
  const selCount = Object.keys(state.selection).filter(d => state.selection[d]).length;

  const filterChip = (key, label, n, cls) =>
    '<button class="badge ' + (cls || "plain") + '" style="cursor:pointer;height:28px;' + (state.list.status === key ? "outline:2px solid var(--accent);outline-offset:1px" : "opacity:.8") + '" data-act="listStatus" data-s="' + key + '">' + label + ' <b class="mono" style="margin-left:2px">' + n + "</b></button>";

  const head = '<div class="page-head"><div style="min-width:0">' +
      '<div class="h1">' + esc(b.name) + "</div>" +
      '<div class="desc row gap-8 center">' + icon(geo.mode === "radius" ? "target" : "route", "") + esc(geoLabel) + ' · snapshot of <b class="mono">' + total + '</b> carriers</div></div>' +
    '<div class="spacer"></div>' +
    (b.new_since ? '<button class="btn" data-act="refreshBatch" data-id="' + b.id + '">' + icon("refresh") + " Refresh <span class='badge good' style='height:18px;margin-left:2px'>+" + b.new_since + "</span></button>" : '<button class="btn" data-act="refreshBatch" data-id="' + b.id + '">' + icon("refresh") + " Refresh</button>") +
    '<button class="btn icon" data-act="batchMenu" data-id="' + b.id + '">' + icon("dots") + "</button></div>";

  const filters = '<div class="card" style="padding:12px 14px;margin-bottom:14px">' +
    '<div class="row wrap gap-6 between">' +
      '<div class="row wrap gap-6 center">' +
        filterChip("all", "All", total, "info") +
        STATUS_ORDER.map(k => filterChip(k, STATUS[k].label, counts[k], k)).join("") +
        (counts.dnc ? filterChip("dnc", "Do Not Call", counts.dnc, "dnc") : "") +
      "</div>" +
      '<div class="seg"><button class="' + (state.list.view === "list" ? "on" : "") + '" data-act="listView" data-v="list">' + icon("list") + "List</button>" +
        '<button class="' + (state.list.view === "map" ? "on" : "") + '" data-act="listView" data-v="map">' + icon("mapicon") + "Map</button></div>" +
    "</div>" +
    '<div class="row wrap gap-8 mt-12">' +
      '<span class="input-group" style="max-width:260px">' + icon("search") + '<input class="input" placeholder="Search name, USDOT, city" value="' + esc(state.list.q) + '" data-model="list.q" data-live="listSearch"></span>' +
      '<select class="select" style="width:auto" data-change="listInsurance"><option value="any"' + sel(state.list.insurance,"any") + '>Any insurance</option><option value="500000"' + sel(state.list.insurance,"500000") + '>$500K+</option><option value="1000000"' + sel(state.list.insurance,"1000000") + '>$1MM+</option></select>' +
      '<select class="select" style="width:auto" data-change="listSize"><option value="any"' + sel(state.list.size,"any") + '>Any size</option><option value="small"' + sel(state.list.size,"small") + '>1–5</option><option value="mid"' + sel(state.list.size,"mid") + '>6–20</option><option value="large"' + sel(state.list.size,"large") + '>21+</option></select>' +
      '<div class="spacer" style="flex:1"></div>' +
      '<select class="select" style="width:auto" data-change="listSort"><option value="name"' + sel(state.list.sort,"name") + '>Sort: Name</option><option value="distance"' + sel(state.list.sort,"distance") + '>Sort: Distance</option><option value="size"' + sel(state.list.sort,"size") + '>Sort: Fleet size</option><option value="recent"' + sel(state.list.sort,"recent") + '>Sort: Recent contact</option></select>' +
    "</div></div>";

  const body = state.list.view === "map" ? workingMap(b, rows) : workingTable(b, rows);
  const bulkbar = selCount ? bulkBar(selCount) : "";
  const inner = '<div class="page wide">' + head + filters + '<div id="wl-body">' + body + "</div>" + bulkbar + "</div>";
  return appShell(inner, crumb([{ label:"Batches", act:"nav", to:"dashboard" }, { label:b.name }]));
}
function workingMap(b, rows) {
  const pins = rows.map(r => ({ lng:r.c.lng, lat:r.c.lat, dot:r.c.dot, from:b.id, r:5,
    fill: r.dnc ? "var(--st-dnc)" : statusVar(r.status), title: r.c.legal_name + " — " + (r.dnc ? "Do Not Call" : STATUS[r.status].label) }));
  return '<div class="map" style="height:560px">' + mapCore(pins, b.search.geo) + mapLegend(false) + "</div>";
}
function workingTable(b, rows) {
  if (!rows.length) return '<div class="card empty">' + icon("filter") + "<div>No carriers match these filters.</div></div>";
  const allSel = rows.filter(r => !r.dnc).every(r => state.selection[r.c.dot]) && rows.some(r => !r.dnc);
  const body = rows.map(r => {
    const c = r.c, last = r.logs[0];
    const cb = r.dnc ? '<td style="width:34px"></td>'
      : '<td style="width:34px"><label class="check"><input type="checkbox" ' + (state.selection[c.dot] ? "checked" : "") + ' data-change="selRow" data-dot="' + c.dot + '"><span class="box">' + icon("check") + "</span></label></td>";
    const statusCell = r.dnc
      ? '<td>' + badge("dnc") + " " + '<span class="subtle" title="Global — set from another batch">' + icon("lock", "") + "</span></td>"
      : '<td><select class="select sm" style="width:130px;color:' + statusVar(r.status) + ';font-weight:700" data-change="rowStatus" data-dot="' + c.dot + '" data-batch="' + b.id + '">' +
          STATUS_ORDER.map(k => '<option value="' + k + '"' + sel(r.status,k) + ">" + STATUS[k].label + "</option>").join("") +
          '<option value="dnc">Do Not Call…</option></select></td>';
    return '<tr class="clickable ' + (r.dnc ? "dnc" : "") + (state.selection[c.dot] ? " sel" : "") + '" data-act="openCarrier" data-dot="' + c.dot + '" data-from="' + b.id + '">' +
      cb +
      "<td><div class='co'><span class='nm'>" + esc(c.legal_name) + "</span><span class='meta'>USDOT <span class='mono'>" + c.dot + "</span>" + (c.tier === 1 ? " · " + badge2("tier1","S&G") : "") + "</span></div></td>" +
      "<td><div class='stack'><span>" + esc(c.city) + ", TX</span>" + (r.dist != null ? "<span class='meta subtle mono'>" + r.dist.toFixed(0) + " mi</span>" : "") + "</div></td>" +
      "<td class='mono'>" + c.power_units + "</td>" +
      "<td>" + insBadge(c) + "</td>" +
      "<td>" + safetyDot(c) + "</td>" +
      statusCell +
      "<td class='muted' style='font-size:12px'>" + (last ? DISPO_LABEL[last.disposition] + "<br><span class='subtle'>" + fmtRel(last.at) + "</span>" : "—") + "</td>" +
      "<td class='right'>" +
        (r.dnc ? "" : '<button class="btn sm" data-act="logCall" data-dot="' + c.dot + '" data-batch="' + b.id + '">' + icon("phone") + "Log</button>") + "</td>" +
    "</tr>";
  }).join("");
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
    '<th><label class="check"><input type="checkbox" ' + (allSel ? "checked" : "") + ' data-change="selAll"><span class="box">' + icon("check") + "</span></label></th>" +
    "<th>Carrier</th><th>Location</th><th>Trucks</th><th>Insurance</th><th>Safety</th><th>Status</th><th>Last contact</th><th></th></tr></thead><tbody>" + body + "</tbody></table></div>";
}
function safetyDot(c) {
  const s = c.safety;
  const cls = s.concerning ? "crit" : (s.rating === "Satisfactory" ? "good" : "plain");
  const label = s.concerning ? "Review" : (s.rating === "Satisfactory" ? "Clean" : "—");
  return '<span class="badge ' + cls + '" title="' + s.crash_total + " crashes · " + s.vehicle_oos_pct + '% OOS">' + label + "</span>";
}
function bulkBar(n) {
  return '<div style="position:fixed;left:calc(var(--sidebar-w) + 24px);right:24px;bottom:20px;background:var(--text);color:var(--bg);border-radius:12px;padding:10px 12px 10px 18px;display:flex;align-items:center;gap:12px;box-shadow:var(--shadow-pop);z-index:30">' +
    '<b class="mono">' + n + "</b> selected" +
    '<div class="spacer" style="flex:1"></div>' +
    '<button class="btn sm" data-act="bulkStatus" data-s="contacted" style="background:transparent;color:var(--bg);border-color:rgba(255,255,255,.25)">Mark contacted</button>' +
    '<button class="btn sm" data-act="bulkStatus" data-s="interested" style="background:transparent;color:var(--bg);border-color:rgba(255,255,255,.25)">Mark interested</button>' +
    '<button class="btn primary sm" data-act="genContact">' + icon("send") + " Generate Contact Options</button>" +
    '<button class="btn icon sm" data-act="clearSel" style="background:transparent;color:var(--bg);border-color:rgba(255,255,255,.25)">' + icon("x") + "</button></div>";
}

/* ------------------------------- CARRIER PROFILE ------------------------------- */
function screenProfile() {
  const c = DB.carrierByDot[state.activeCarrierDot];
  if (!c) { state.screen = "dashboard"; return screenDashboard(); }
  const dnc = effDnc(c.dot), fromBatch = state.profileFromBatch ? DB.batches.find(b => b.id === state.profileFromBatch) : null;
  const onboarded = c.dot in state.overrides.onboarded || DB.batchCarriers.some(b => b.dot === c.dot && b.onboarded_at);
  const crumbs = fromBatch ? [{ label:"Batches", act:"nav", to:"dashboard" }, { label:fromBatch.name, act:"openBatch", to:fromBatch.id }, { label:c.legal_name }]
                           : [{ label:"Batches", act:"nav", to:"dashboard" }, { label:c.legal_name }];

  const header = '<div class="card" style="padding:18px 20px;margin-bottom:16px">' +
    '<div class="row between wrap gap-12" style="align-items:flex-start">' +
      '<div style="min-width:0"><div class="row gap-10 center wrap">' +
        '<h1 style="font-size:22px;font-weight:800">' + esc(c.legal_name) + "</h1>" +
        (c.tier === 1 ? badge2("tier1","Sand & Gravel") : c.tier === 2 ? badge2("tier2","Tier 2") : '<span class="badge plain">No cargo match</span>') +
        (c.active ? '<span class="badge good"><span class="dot"></span>Active</span>' : '<span class="badge plain">Inactive</span>') +
        (dnc ? '<span class="badge dnc">' + icon("lock","") + " Do Not Call</span>" : "") +
      "</div>" +
      '<div class="row gap-16 mt-8 muted" style="font-size:13px;flex-wrap:wrap">' +
        "<span>USDOT <b class='mono' style='color:var(--text)'>" + c.dot + "</b></span>" +
        (c.dba ? "<span>DBA " + esc(c.dba) + "</span>" : "") +
        "<span>" + icon("pin","") + " " + esc(c.city) + ", TX</span>" +
        "<span>" + esc(c.classdef) + "</span></div></div>" +
      '<div class="row gap-8 none">' +
        (onboarded ? '<span class="badge good" style="height:34px;padding:0 12px">' + icon("check","") + " In onboarding</span>"
                   : '<button class="btn primary" data-act="sendOnboard" data-dot="' + c.dot + '">' + icon("arrowR") + " Send to Onboarding</button>") +
      "</div></div>" +
    '<div class="row between wrap gap-12 mt-16" style="padding-top:14px;border-top:1px solid var(--border)">' +
      '<label class="switch danger"><input type="checkbox" ' + (dnc ? "checked" : "") + ' data-act="toggleDnc" data-dot="' + c.dot + '"><span class="track"></span>' +
        '<span><b>Do Not Call</b> <span class="subtle">— global, suppresses this carrier in every batch &amp; channel</span></span></label>' +
      '<div class="row gap-8">' + contactChip("phone", c.phone) + (c.cell ? contactChip("phone", c.cell + " (cell)") : "") + (c.email ? contactChip("mail", c.email) : '<span class="badge plain">' + icon("mail","") + " no email on file</span>") + "</div>" +
    "</div></div>";

  const main = '<div class="card" style="padding:0"><div class="tabs" style="padding:0 8px">' +
    ["overview","insurance","safety","inspections","general"].map(t => '<button class="' + (state.profileTab === t ? "on" : "") + '" data-act="profileTab" data-t="' + t + '">' + ({overview:"Overview",insurance:"Insurance",safety:"Safety",inspections:"Inspections",general:"General"}[t]) + "</button>").join("") +
    '</div><div style="padding:18px 20px">' + profileTab(c) + "</div></div>";

  const rail = '<div class="stack gap-16">' + callPanel(c, fromBatch, dnc) + batchMembership(c) + "</div>";

  const inner = '<div class="page">' +
    (fromBatch ? '<a class="link row gap-6 center" style="margin-bottom:12px" data-act="openBatch" data-id="' + fromBatch.id + '">' + icon("chevL") + " Back to " + esc(fromBatch.name) + "</a>" : "") +
    header +
    '<div style="display:grid;grid-template-columns:1fr 360px;gap:16px;align-items:start">' + main + rail + "</div></div>";
  return appShell(inner, crumb(crumbs));
}
function contactChip(ic, text) { return '<span class="badge plain" style="height:30px">' + icon(ic,"") + " " + esc(text) + "</span>"; }
function profileTab(c) {
  if (state.profileTab === "insurance") {
    const i = c.ins;
    return kv([["Authority status", '<span class="badge ' + (i.authority_status==="active"?"good":i.authority_status==="pending"?"warn":"plain") + '">' + i.authority_status + "</span>"],
      ["Authority type", i.authority_type],
      ["BIPD on file", '<b class="mono">' + fmtMoney(i.bipd_on_file) + "</b>" + (i.bipd_on_file >= 1000000 ? ' <span class="badge good">meets $1MM</span>' : i.bipd_on_file ? ' <span class="badge warn">below $1MM</span>' : ' <span class="badge crit">none</span>')],
      ["BIPD required", '<span class="mono">' + fmtMoney(i.bipd_required) + "</span>"],
      ["Cargo insurance", '<span class="mono">' + fmtMoney(i.cargo_on_file) + "</span>"],
      ["Effective", '<span class="mono">' + i.effective + "</span>"]]) +
      '<div class="demo-note mt-16">Insurance &amp; authority come from FMCSA\'s <b>Licensing &amp; Insurance</b> dataset, joined to the census on USDOT #.</div>';
  }
  if (state.profileTab === "safety") {
    const s = c.safety;
    return '<div class="stat-row" style="margin-bottom:16px">' +
      stat("Crashes (24mo)", s.crash_total) + stat("Inspections", s.inspections_24mo) +
      stat("Vehicle OOS", s.vehicle_oos_pct, "%") + stat("Driver OOS", s.driver_oos_pct, "%") + "</div>" +
      kv([["Safety rating", '<span class="badge ' + (s.rating==="Satisfactory"?"good":s.rating==="Conditional"?"crit":"plain") + '">' + s.rating + "</span>"], ["Rating date", '<span class="mono">' + s.rating_date + "</span>"]]) +
      (s.concerning ? '<div class="demo-note mt-16" style="border-color:var(--crit);color:var(--crit)">' + icon("alert","") + " Flagged: concerning safety history (excluded when the safety filter is on).</div>"
                    : '<div class="demo-note mt-16">Public safety signals only — FMCSA removed BASIC percentile scores from public display in 2025.</div>');
  }
  if (state.profileTab === "inspections") {
    if (!c.inspections.length) return '<div class="empty">' + icon("shield") + "<div>No inspection detail on file for this carrier.</div></div>";
    return '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>State</th><th>Level</th><th>Result</th><th>Violations</th></tr></thead><tbody>' +
      c.inspections.map(x => "<tr><td class='mono'>" + x.date + "</td><td>" + x.state + "</td><td>" + x.level + "</td><td>" + (x.result==="Clean"?'<span class="badge good">Clean</span>':'<span class="badge crit">OOS</span>') + "</td><td class='mono'>" + x.violations + "</td></tr>").join("") +
      "</tbody></table></div>";
  }
  if (state.profileTab === "general") {
    return kv([["Legal name", esc(c.legal_name)], ["DBA", c.dba ? esc(c.dba) : "—"], ["Entity type", c.entity],
      ["Operation", c.operation], ["Classification", c.classdef], ["Power units", '<span class="mono">' + c.power_units + "</span>"],
      ["Drivers", '<span class="mono">' + c.drivers + "</span>"], ["MCS-150 date", '<span class="mono">' + c.mcs150 + "</span>"],
      ["Physical address", esc(c.street + ", " + c.city + ", TX " + c.zip)]]);
  }
  // overview
  const cargo = (c.cargoOther ? '<span class="badge tier1">Other: "' + esc(c.cargoOther) + '"</span> ' : "") + c.cargoFlags.map(f => '<span class="badge plain">' + esc(f) + "</span>").join(" ");
  return '<div class="stat-row" style="margin-bottom:18px">' +
      stat("Trucks", c.power_units) + stat("Drivers", c.drivers) + stat("Insurance", fmtMoney(c.ins.bipd_on_file)) + stat("Safety", c.safety.concerning ? "Review" : "OK") + "</div>" +
    '<div class="eyebrow" style="margin-bottom:8px">Cargo carried</div><div class="row wrap gap-6" style="margin-bottom:18px">' + (cargo || "—") + "</div>" +
    kv([["Phone", '<span class="mono">' + esc(c.phone) + "</span>"], ["Cell", c.cell ? '<span class="mono">' + esc(c.cell) + "</span>" : "—"],
      ["Email", c.email ? esc(c.email) : '<span class="subtle">not on file</span>'], ["Address", esc(c.city + ", TX " + c.zip)]]);
}
function kv(rows) { return '<dl class="kv">' + rows.map(r => "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>").join("") + "</dl>"; }
function callPanel(c, fromBatch, dnc) {
  const logs = logsForDot(c.dot);
  const statusControl = dnc
    ? '<div class="badge dnc" style="height:32px">' + icon("lock","") + " Do Not Call — calling disabled</div>"
    : fromBatch
      ? '<select class="select" data-change="rowStatus" data-dot="' + c.dot + '" data-batch="' + fromBatch.id + '" style="font-weight:700;color:' + statusVar(effStatus(fromBatch.id, c.dot)) + '">' +
          STATUS_ORDER.map(k => '<option value="' + k + '"' + sel(effStatus(fromBatch.id, c.dot), k) + ">" + STATUS[k].label + "</option>").join("") + '<option value="dnc">Do Not Call…</option></select>'
      : '<div class="subtle" style="font-size:12px">Open this carrier from a batch to set a working status.</div>';
  const timeline = logs.length ? logs.map(l => {
    const u = DB.userById[l.user_id], bt = DB.batches.find(b => b.id === l.batch_id);
    return '<div class="row gap-10" style="padding:12px 0;border-top:1px solid var(--border)">' + avatar(u, 26) +
      '<div style="min-width:0;flex:1"><div class="row between center"><span class="badge ' + dispoCls(l.disposition) + '">' + DISPO_LABEL[l.disposition] + "</span>" +
        '<span class="subtle mono" style="font-size:11px">' + fmtRel(l.at) + "</span></div>" +
        (l.notes ? '<div style="font-size:12.5px;margin-top:5px">' + esc(l.notes) + "</div>" : "") +
        (l.next_steps ? '<div class="subtle" style="font-size:11.5px;margin-top:3px">Next: ' + esc(l.next_steps) + "</div>" : "") +
        '<div class="subtle" style="font-size:11px;margin-top:4px">' + esc(u.name.split(" ")[0]) + (bt ? " · " + esc(bt.name) : "") + "</div></div></div>";
  }).join("") : '<div class="subtle" style="font-size:12.5px;padding:12px 0">No contact attempts logged yet.</div>';

  return '<div class="card" style="padding:16px">' +
    '<div class="row between center" style="margin-bottom:12px"><div class="eyebrow">Call workflow</div>' +
      (fromBatch ? '<span class="subtle" style="font-size:11px">in ' + esc(fromBatch.name) + "</span>" : "") + "</div>" +
    '<div class="field" style="margin-bottom:12px"><span class="label">Status in this batch</span>' + statusControl + "</div>" +
    (dnc ? "" : '<button class="btn primary block" data-act="logCall" data-dot="' + c.dot + '"' + (fromBatch ? ' data-batch="' + fromBatch.id + '"' : "") + ">" + icon("phone") + " Log a call</button>") +
    '<div class="eyebrow" style="margin:18px 0 2px">Contact history <span class="subtle">· all batches</span></div>' + timeline + "</div>";
}
function dispoCls(d) { return ["connected","interested"].includes(d) ? "good" : ["no_answer","wrong_number","not_interested"].includes(d) ? "plain" : "warn"; }
function batchMembership(c) {
  const mems = DB.batchCarriers.filter(b => b.dot === c.dot);
  if (!mems.length) return "";
  return '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px">In these batches <span class="subtle">· ' + mems.length + "</span></div>" +
    mems.map(m => { const b = DB.batches.find(x => x.id === m.batch_id); const st = effStatus(b.id, c.dot);
      return '<button class="mem-row row between center" data-act="openBatchCarrier" data-batch="' + b.id + '" data-dot="' + c.dot + '">' +
        '<span style="font-size:13px;font-weight:600;text-align:left">' + esc(b.name) + "</span>" + (effDnc(c.dot) ? badge("dnc") : badge(st)) + "</button>";
    }).join("") +
    '<div class="subtle" style="font-size:11px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">Status is tracked <b>per batch</b> — this carrier can be "Interested" in one and "New" in another.</div></div>';
}

/* ------------------------------- USERS ADMIN ------------------------------- */
function userRow(u) {
  const ov = state.overrides.userStatus[u.id];
  const status = ov ? ov.status : u.status, role = ov ? ov.role : u.role;
  return { u, status, role };
}
function screenUsers() {
  if (cur().role !== "manager") { state.screen = "dashboard"; return screenDashboard(); }
  const all = DB.users.map(userRow);
  const pending = all.filter(r => r.status === "pending");
  const active = all.filter(r => r.status !== "pending");
  const inner = '<div class="page">' +
    '<div class="page-head"><div><div class="h1">Users &amp; Access</div><div class="desc">Approve new accounts and set roles. Guests can only see a landing page until you provision them.</div></div></div>' +
    (pending.length ? '<div class="card" style="padding:16px;margin-bottom:18px;border-color:var(--warn)">' +
      '<div class="row gap-8 center" style="margin-bottom:12px">' + icon("clock","") + '<b>Pending approval</b><span class="badge warn">' + pending.length + "</span></div>" +
      pending.map(r => '<div class="row between center wrap gap-10" style="padding:10px 0;border-top:1px solid var(--border)">' +
        '<div class="row gap-10 center">' + avatar(r.u) + "<div><div style='font-weight:700'>" + esc(r.u.name) + "</div><div class='subtle' style='font-size:12px'>" + esc(r.u.email) + " · registered " + fmtRel(r.u.registered) + "</div></div></div>" +
        '<div class="row gap-8"><button class="btn sm" data-act="rejectUser" data-uid="' + r.u.id + '">Reject</button>' +
          '<button class="btn primary sm" data-act="approveUser" data-uid="' + r.u.id + '">' + icon("usercheck") + " Approve</button></div></div>").join("") +
      "</div>" : "") +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' +
      active.map(r => "<tr><td><div class='row gap-10 center'>" + avatar(r.u, 28) + "<span class='nm' style='font-weight:700'>" + esc(r.u.name) + "</span></div></td>" +
        "<td class='muted'>" + esc(r.u.email) + "</td>" +
        "<td>" + (r.u.id === "u_manager" ? '<span class="badge tier1">Manager</span>' : '<select class="select sm" style="width:110px" data-change="setRole" data-uid="' + r.u.id + '"><option value="edit"' + sel(r.role,"edit") + ">Editor</option><option value=\"view\"" + sel(r.role,"view") + ">Viewer</option><option value=\"manager\"" + sel(r.role,"manager") + ">Manager</option></select>") + "</td>" +
        "<td>" + (r.status === "suspended" ? '<span class="badge crit">Suspended</span>' : '<span class="badge good"><span class="dot"></span>Approved</span>') + "</td>" +
        "<td class='right'>" + (r.u.id === "u_manager" ? '<span class="subtle" style="font-size:12px">you</span>' : '<button class="btn sm danger" data-act="suspendUser" data-uid="' + r.u.id + '">' + (r.status === "suspended" ? "Restore" : "Suspend") + "</button>") + "</td></tr>").join("") +
    "</tbody></table></div></div>";
  return appShell(inner, crumb([{ label:"Users" }]));
}

/* ------------------------------- MENUS ------------------------------- */
const MENUS = {
  userMenu: () => { const u = cur(); return '<div style="padding:8px 10px"><div style="font-weight:700">' + esc(u.name) + '</div><div class="subtle" style="font-size:12px">' + esc(u.email) + " · " + ROLE_LABEL[u.role] + "</div></div><div class='sep'></div>" +
    '<button data-act="toggleTheme">' + icon("moon") + ' Toggle theme</button><button data-act="logout">' + icon("logout") + " Sign out</button>"; },
  batchMenu: (m) => '<button data-act="renameBatch" data-id="' + m.id + '">' + icon("edit") + ' Rename</button>' +
    '<button data-act="refreshBatch" data-id="' + m.id + '">' + icon("refresh") + " Refresh members</button><div class='sep'></div>" +
    '<button class="danger" data-act="deleteBatch" data-id="' + m.id + '">' + icon("trash") + " Delete batch</button>"
};

/* ------------------------------- MODALS ------------------------------- */
const MODALS = {
  dnc: (m) => modalWrap("Set Do Not Call?", "lock",
    "<p>This flags <b>" + esc(DB.carrierByDot[m.dot].legal_name) + "</b> as <b>Do Not Call</b>. It's a <b>global</b> suppression — the carrier will be locked in <b>every batch</b> and across all future channels (call, email, text, mail).</p>",
    '<button class="btn" data-act="closeModal">Cancel</button><button class="btn danger" data-act="confirmDnc" data-dot="' + m.dot + '">' + icon("lock") + " Set Do Not Call</button>"),
  undnc: (m) => modalWrap("Clear Do Not Call?", "check",
    "<p>Re-enable contact for <b>" + esc(DB.carrierByDot[m.dot].legal_name) + "</b> across all batches?</p>",
    '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="confirmUndnc" data-dot="' + m.dot + '">Clear flag</button>'),
  onboard: (m) => modalWrap("Send to Onboarding?", "arrowR",
    "<p>This hands <b>" + esc(DB.carrierByDot[m.dot].legal_name) + "</b> (USDOT <span class='mono'>" + m.dot + "</span>) to the carrier onboarding tool. Only the USDOT # is passed — onboarding re-imports the FMCSA data automatically.</p>",
    '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="confirmOnboard" data-dot="' + m.dot + '">' + icon("arrowR") + " Send USDOT " + m.dot + "</button>"),
  rename: (m) => modalWrap("Rename batch", "edit",
    '<label class="field"><span class="label">Batch name</span><input class="input" id="rename-input" value="' + esc(DB.batches.find(b => b.id === m.id).name) + '"></label>',
    '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="confirmRename" data-id="' + m.id + '">Save</button>'),
  del: (m) => modalWrap("Delete batch?", "trash",
    "<p>Delete <b>" + esc(DB.batches.find(b => b.id === m.id).name) + "</b> and its working statuses? The carriers stay in your database and other batches. This can't be undone.</p>",
    '<button class="btn" data-act="closeModal">Cancel</button><button class="btn danger" data-act="confirmDelete" data-id="' + m.id + '">Delete batch</button>'),
  refresh: (m) => modalWrap("Batch refreshed", "refresh",
    "<p>Re-ran the saved search. <b>" + m.added + " new</b> carrier" + (m.added === 1 ? "" : "s") + " matched since the snapshot and " + (m.added ? "were added" : "nothing changed") + ". Existing members and their statuses were kept.</p>",
    '<button class="btn primary" data-act="closeModal">Done</button>'),
  log: (m) => {
    const c = DB.carrierByDot[m.dot];
    return modalWrap("Log a call — " + esc(c.legal_name), "phone",
      '<form data-submit="submitLog" id="logform"><input type="hidden" data-dot="' + m.dot + '"' + (m.batch ? ' data-batch="' + m.batch + '"' : "") + '>' +
      '<div class="row gap-16 mt-4" style="margin-bottom:12px"><span class="badge plain" style="height:30px">' + icon("phone","") + " " + esc(c.phone) + "</span>" + (c.cell ? '<span class="badge plain" style="height:30px">' + esc(c.cell) + " (cell)</span>" : "") + "</div>" +
      '<div class="stack gap-12">' +
        fieldRow("Outcome", '<select class="select" id="log-dispo">' + ["connected","no_answer","voicemail","callback","interested","not_interested","wrong_number"].map(d => '<option value="' + d + '">' + DISPO_LABEL[d] + "</option>").join("") + "</select>") +
        fieldRow("Notes", '<textarea class="textarea" id="log-notes" placeholder="What was said…"></textarea>') +
        fieldRow("Next steps", '<input class="input" id="log-next" placeholder="e.g. Send rate sheet, call back Thu">') +
        (m.batch ? fieldRow("Update status in this batch to", '<select class="select" id="log-status"><option value="">— leave unchanged —</option>' + STATUS_ORDER.map(k => '<option value="' + k + '">' + STATUS[k].label + "</option>").join("") + "</select>") : "") +
      "</div></form>",
      '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="submitLogBtn">' + icon("check") + " Save call</button>");
  },
  contact: (m) => {
    const dots = m.dots, rows = dots.map(d => DB.carrierByDot[d]);
    const withPhone = rows.filter(r => r.phone).length, withEmail = rows.filter(r => r.email).length;
    return modalWrapLg("Generate Contact Options", "send",
      '<div class="row gap-10 wrap" style="margin-bottom:14px">' +
        '<span class="badge info" style="height:28px"><b class="mono">' + rows.length + "</b>&nbsp;carriers</span>" +
        '<span class="badge good" style="height:28px">' + icon("phone","") + " " + withPhone + " with phone</span>" +
        '<span class="badge ' + (withEmail ? "warn" : "plain") + '" style="height:28px">' + icon("mail","") + " " + withEmail + " with email</span></div>" +
      '<div class="tbl-wrap" style="max-height:280px;overflow-y:auto"><table class="tbl"><thead><tr><th>Carrier</th><th>Phone</th><th>Cell</th><th>City</th></tr></thead><tbody>' +
        rows.map(r => "<tr><td class='nm' style='font-weight:600'>" + esc(r.legal_name) + "</td><td class='mono'>" + esc(r.phone) + "</td><td class='mono muted'>" + (r.cell ? esc(r.cell) : "—") + "</td><td>" + esc(r.city) + "</td></tr>").join("") +
        "</tbody></table></div>" +
      '<div class="row wrap gap-8 mt-16"><button class="btn" data-act="toast" data-msg="Call sheet ready — ' + rows.length + ' carriers" data-ic="printer">' + icon("printer") + ' Print call sheet</button>' +
        '<button class="btn" data-act="toast" data-msg="Exported ' + rows.length + ' rows to CSV" data-ic="download">' + icon("download") + ' Export CSV</button>' +
        '<button class="btn" data-act="toast" data-msg="Copied ' + rows.length + ' USDOT numbers" data-ic="check">' + icon("check") + ' Copy USDOT list</button></div>' +
      '<div class="demo-note mt-16">Email &amp; text blasts arrive in later phases — this Phase-1 step produces the <b>call sheet</b> your team works from. Do-Not-Call carriers are automatically excluded.</div>',
      '<button class="btn primary" data-act="closeModal">Done</button>');
  },
  approve: (m) => {
    const u = DB.userById[m.uid];
    return modalWrap("Approve " + esc(u.name), "usercheck",
      "<p>Give <b>" + esc(u.name) + "</b> access and assign a role:</p>" +
      '<div class="stack gap-8 mt-12"><label class="check" style="padding:10px;border:1px solid var(--border);border-radius:8px"><input type="radio" name="approle" value="edit" checked><span class="box">' + icon("check") + '</span><span><b>Editor</b> — search, work the list, log calls, change statuses</span></label>' +
      '<label class="check" style="padding:10px;border:1px solid var(--border);border-radius:8px"><input type="radio" name="approle" value="view"><span class="box">' + icon("check") + '</span><span><b>Viewer</b> — read-only access to batches and carriers</span></label></div>',
      '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="confirmApprove" data-uid="' + m.uid + '">Approve &amp; provision</button>');
  }
};
function modalWrap(title, ic, body, foot) {
  return '<div class="scrim" data-act="closeModal"><div class="modal"><div class="modal-head">' + icon(ic) + '<span class="t">' + esc(title) + '</span></div><div class="modal-body">' + body + '</div><div class="modal-foot">' + foot + "</div></div></div>";
}
function modalWrapLg(title, ic, body, foot) {
  return '<div class="scrim" data-act="closeModal"><div class="modal lg"><div class="modal-head">' + icon(ic) + '<span class="t">' + esc(title) + '</span></div><div class="modal-body">' + body + '</div><div class="modal-foot">' + foot + "</div></div></div>";
}

/* ------------------------------- SCREENS map ------------------------------- */
const SCREENS = {
  login: screenLogin, register: screenRegister, forgot: screenForgot, guest: screenGuest,
  dashboard: screenDashboard, builder: screenBuilder, workingList: screenWorkingList,
  profile: screenProfile, users: screenUsers
};
