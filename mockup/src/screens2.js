/* ============================================================================
   screens2.js — batch working page, carrier profile (3 variants), users,
   modals, menus.
   ============================================================================ */

/* ------------------------------- BATCH PAGE ------------------------------- */
function workingRows(batchId) {
  const b = DB.batches.find(x => x.id === batchId), f = state.list;
  let rows = batchMembers(batchId).map(m => {
    const c = DB.carrierByDot[m.dot];
    return { c, dnc: effDnc(m.dot), status: effStatus(batchId, m.dot), dist: distanceToSearch(c, b.zones),
             warns: warningsFor(c), logs: logsForDot(m.dot), promoted: effPromoted(m.dot) };
  });
  if (f.status !== "all") rows = rows.filter(r => f.status === "dnc" ? r.dnc : (!r.dnc && r.status === f.status));
  if (f.warnings) rows = rows.filter(r => r.warns.length);
  if (f.q) { const q = f.q.toLowerCase(); rows = rows.filter(r => r.c.legal_name.toLowerCase().includes(q) || String(r.c.dot).includes(q) || r.c.city.toLowerCase().includes(q) || (r.c.contact_name||"").toLowerCase().includes(q)); }
  if (f.insurance !== "any") rows = rows.filter(r => r.c.ins.bipd_on_file >= +f.insurance);
  if (f.size !== "any") { const [lo, hi] = SIZE_RANGES[f.size]; rows = rows.filter(r => (lo==null||r.c.power_units>=lo) && (hi==null||r.c.power_units<=hi)); }
  if (f.contact === "phone") rows = rows.filter(r => r.c.phone || r.c.cell);
  else if (f.contact === "email") rows = rows.filter(r => r.c.email);
  else if (f.contact === "missing") rows = rows.filter(r => !r.c.email && !(r.c.phone||r.c.cell));
  rows.sort((a, z) => f.sort === "distance" ? (a.dist||0)-(z.dist||0) : f.sort === "size" ? z.c.power_units-a.c.power_units :
    f.sort === "recent" ? ((z.logs[0]?.at)||0)-((a.logs[0]?.at)||0) : f.sort === "warnings" ? z.warns.length-a.warns.length : a.c.legal_name.localeCompare(z.c.legal_name));
  return rows;
}
function screenWorkingList() {
  const b = DB.batches.find(x => x.id === state.activeBatchId);
  if (!b) { state.screen = "dashboard"; return screenDashboard(); }
  const rows = workingRows(b.id), counts = statusCounts(b.id);
  const selCount = Object.keys(state.selection).filter(d => state.selection[d]).length;
  // F42: lane/material chips removed from the header (dead space); they live in the map legend now.
  const head = '<div class="page-head"><div style="min-width:0"><div class="h1">' + esc(b.name) + '</div><div class="muted" style="font-size:13px;margin-top:2px">' + esc(b.customer) + " · " + esc(b.job) + " · " + b.zones.length + " lane" + (b.zones.length===1?"":"s") + '</div></div><div class="spacer"></div>' +
    (b.new_since ? '<button class="btn" data-act="refreshBatch" data-id="' + b.id + '">' + icon("refresh") + " Refresh <span class='badge good' style='height:18px;margin-left:2px'>+" + b.new_since + "</span></button>" : '<button class="btn" data-act="refreshBatch" data-id="' + b.id + '">' + icon("refresh") + " Refresh</button>") +
    '<button class="btn icon" data-act="batchMenu" data-id="' + b.id + '">' + icon("dots") + "</button></div>";
  const feed = activityCard(b.id);   // F32: collapsed by default, rendered BELOW the stat tiles
  const strip = statStrip(stat("Carriers", counts.total) + stat("With phone", counts.phone) + stat("With email", counts.email, counts.email ? "" : "crit") + stat("Interested", counts.interested, "good") + stat("Warnings", counts.warnings, counts.warnings ? "crit" : "") + stat("Promoted", counts.promoted, "accent"));
  const chip = (key, label, n, cls) => '<button class="badge ' + (cls||"plain") + '" style="cursor:pointer;height:28px;' + (state.list.status === key ? "outline:2px solid var(--accent);outline-offset:1px" : "opacity:.82") + '" data-act="listStatus" data-s="' + key + '">' + label + ' <b class="mono" style="margin-left:2px">' + n + "</b></button>";
  const chips = '<div class="row wrap gap-6 center">' + chip("all","All",counts.total,"info") + STATUS_ORDER.map(k => chip(k, STATUS[k].label, counts[k], k)).join("") + (counts.dnc ? chip("dnc","Do Not Call",counts.dnc,"dnc") : "") +
    '<button class="badge ' + (state.list.warnings?"crit":"plain") + '" style="cursor:pointer;height:28px;' + (state.list.warnings?"outline:2px solid var(--crit);outline-offset:1px":"opacity:.82") + '" data-act="listWarnings">' + icon("alert") + " Warnings only <b class='mono'>" + counts.warnings + "</b></button></div>";
  const toolbar = '<div class="row wrap gap-8 mt-12">' +
    '<span class="input-group" style="max-width:240px">' + icon("search") + '<input class="input" placeholder="Name, USDOT, contact, city" value="' + esc(state.list.q) + '" data-model="list.q" data-live="listSearch"></span>' +
    '<select class="select" style="width:auto" data-change="listInsurance"><option value="any"' + sel(state.list.insurance,"any") + '>Any insurance</option><option value="500000"' + sel(state.list.insurance,"500000") + '>$500K+</option><option value="1000000"' + sel(state.list.insurance,"1000000") + '>$1MM+</option></select>' +
    '<select class="select" style="width:auto" data-change="listContact"><option value="any"' + sel(state.list.contact,"any") + '>Any contact</option><option value="phone"' + sel(state.list.contact,"phone") + '>Has phone</option><option value="email"' + sel(state.list.contact,"email") + '>Has email</option><option value="missing"' + sel(state.list.contact,"missing") + '>Missing both</option></select>' +
    '<div class="spacer" style="flex:1"></div>' +
    '<select class="select" style="width:auto" data-change="listSort"><option value="name"' + sel(state.list.sort,"name") + '>Sort: Name</option><option value="distance"' + sel(state.list.sort,"distance") + '>Sort: Distance</option><option value="size"' + sel(state.list.sort,"size") + '>Sort: Fleet</option><option value="recent"' + sel(state.list.sort,"recent") + '>Sort: Recent</option><option value="warnings"' + sel(state.list.sort,"warnings") + '>Sort: Warnings</option></select>' +
    '<div class="seg"><button class="' + (state.list.view==="list"?"on":"") + '" data-act="listView" data-v="list">' + icon("list") + "List</button><button class=\"" + (state.list.view==="map"?"on":"") + "\" data-act=\"listView\" data-v=\"map\">" + icon("mapicon") + "Map</button></div></div>";
  const filters = '<div class="card" style="padding:12px 14px;margin:14px 0">' + chips + toolbar + "</div>";
  const body = state.list.view === "map" ? workingMap(b, rows) : workingTable(b, rows);
  const inner = '<div class="page wide">' + head + strip + '<div class="mt-12">' + feed + "</div>" + filters + '<div id="wl-body">' + body + "</div>" + (selCount ? bulkBar(selCount) : "") + "</div>";
  return appShell(inner, crumb([{ label:"Dashboard", act:"nav", to:"dashboard" }, { label:b.name }]));
}
function activityCard(batchId) {
  const items = activityForBatch(batchId), open = state.feedOpen;
  if (!open) {
    const last = items[0];
    const u = last ? DB.userById[last.actor_id] : null;
    return '<button class="feed-bar" data-act="toggleFeed">' + icon("activity") + '<b>Activity</b><span class="badge plain" style="height:19px">' + items.length + "</span>" +
      (last ? '<span class="subtle" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">latest: ' + esc(u ? u.name.split(" ")[0] : "") + (last.type === "comment" ? " commented" : " · " + last.type.replace(/_/g, " ")) + " · " + fmtRel(last.at) + "</span>" : "") +
      '<span style="margin-left:auto" class="row gap-4 center subtle">Expand ' + icon("chevD") + "</span></button>";
  }
  const shown = items;
  const line = a => {
    const u = DB.userById[a.actor_id], nm = u ? u.name.split(" ")[0] : "System";
    if (a.type === "comment") return { ic:"comment", cls:"comment", html: "<b>" + esc(nm) + "</b> commented", body: a.body };
    if (a.type === "batch_created") return { ic:"plus", html: "<b>" + esc(nm) + "</b> created this batch" };
    if (a.type === "members_added") return { ic:"layers", html: "<b>" + esc(nm) + "</b> added <b>" + (a.payload.count||"") + "</b> carriers" };
    if (a.type === "refresh") return { ic:"refresh", html: "<b>" + esc(nm) + "</b> refreshed — +" + (a.payload.added||0) + " new" };
    if (a.type === "status_change") return { ic:"activity", html: "<b>" + esc(nm) + "</b> set " + esc((DB.carrierByDot[a.payload.dot]||{}).legal_name||"a carrier") + " → " + (STATUS[a.payload.to]?.label||a.payload.to) };
    if (a.type === "bulk_status_change") return { ic:"activity", html: "<b>" + esc(nm) + "</b> set <b>" + a.payload.count + "</b> carriers → " + (STATUS[a.payload.to]?.label||a.payload.to) };
    if (a.type === "promoted") return { ic:"arrowR", html: "<b>" + esc(nm) + "</b> marked " + esc((DB.carrierByDot[a.payload.dot]||{}).legal_name||"a carrier") + " as promoted" };
    if (a.type === "dnc_set") return { ic:"lock", html: "<b>" + esc(nm) + "</b> set Do-Not-Call on " + esc((DB.carrierByDot[a.payload.dot]||{}).legal_name||"a carrier") };
    if (a.type === "export") return { ic:"download", html: "<b>" + esc(nm) + "</b> generated a " + esc(a.payload.kind||"contact") + " sheet (" + (a.payload.count||0) + ")" };
    return { ic:"activity", html: esc(a.type) };
  };
  const feed = shown.map(a => { const L = line(a), u = DB.userById[a.actor_id]; return '<div class="feed-item"><div class="feed-ic ' + (L.cls||"") + '">' + icon(L.ic) + '</div><div class="feed-body">' + L.html + (L.body ? '<div class="fcomment">' + esc(L.body) + "</div>" : "") + '<div class="fmeta">' + fmtRel(a.at) + "</div></div></div>"; }).join("");
  const cur_ = cur();
  const composer = '<div class="composer"><span>' + avatar(cur_, 27) + '</span><span class="input-group grow"><input class="input" placeholder="Leave an activity comment…" id="feed-comment" data-keyadd="postComment"></span><button class="btn primary sm" data-act="postCommentBtn">Post</button></div>';
  return '<div class="card" style="padding:14px 16px"><div class="row between center" style="margin-bottom:10px"><div class="eyebrow">' + icon("activity") + ' Activity <span class="subtle">· ' + items.length + '</span></div><button class="btn ghost sm" data-act="toggleFeed">Collapse ' + icon("chevD") + "</button></div>" + composer + '<div class="feed" style="max-height:300px;overflow-y:auto">' + feed + "</div></div>";
}
function workingMap(b, rows) {
  const pins = rows.map((r, i) => ({ lng:r.c.lng, lat:r.c.lat, dot:r.c.dot, from:b.id, r:7, num:i+1, shape:"pin",
    fill: r.dnc ? "var(--st-dnc)" : statusVar(r.status), warn: r.warns.length > 0, title: r.c.legal_name }));
  // F42: lanes + materials live here, with the status key.
  const counts = statusCounts(b.id);
  const laneRows = b.zones.map((z, i) => '<div class="lg"><span class="sw" style="background:' + laneColor(i) + ';border-radius:2px"></span><b>' + "ABCDEFGH"[i] + "</b>&nbsp;" + esc(z.label || "") + ' <span class="subtle">· ' + (z.type === "radius" ? esc(z.anchor.replace(", TX","")) + " " + z.radiusMi + "mi" : esc(z.origin.replace(", TX","")) + "→" + esc(z.dest.replace(", TX","")) + " " + z.bufferMi + "mi") + "</span></div>").join("");
  const legend = '<div class="map-legend">' + STATUS_ORDER.map(k => '<div class="lg"><span class="sw" style="background:' + statusVar(k) + '"></span>' + STATUS[k].label + " · " + counts[k] + "</div>").join("") +
    (counts.dnc ? '<div class="lg"><span class="sw" style="background:var(--st-dnc)"></span>Do Not Call · ' + counts.dnc + "</div>" : "") +
    '<div class="lg" style="font-weight:700;color:var(--text);margin-top:4px">Lanes</div>' + laneRows + "</div>";
  return mapBox("batch", pins, b.zones, legend, 560);
}
/* F44: cargo-signal tags — S&G is not the only one worth seeing; carriers can carry several. */
function tagsFor(c) {
  const t = [];
  if (c.tier === 1) t.push('<span class="badge tier1" style="height:17px">S&amp;G</span>');
  if (c.cargoFlags.includes("Commodities Dry Bulk")) t.push('<span class="badge plain" style="height:17px">Dry Bulk</span>');
  if (c.cargoFlags.includes("Construction")) t.push('<span class="badge plain" style="height:17px">Constr</span>');
  if (c.cargoFlags.includes("Building Materials")) t.push('<span class="badge plain" style="height:17px">Bldg Mat</span>');
  return t.length ? '<span class="wchips stack">' + t.join("") + "</span>" : '<span class="subtle">—</span>';
}
function safetyDot(c) { const w = warningsFor(c); const bad = w.some(x => ["safety_rating","high_oos","recent_crashes"].includes(x)); return bad ? '<span class="badge crit">Review</span>' : (c.safety.rating === "Satisfactory" ? '<span class="badge good">Clean</span>' : '<span class="subtle">—</span>'); }
function workingTable(b, rows) {
  if (!rows.length) return '<div class="card empty">' + icon("filter") + "<div>No carriers match these filters.</div></div>";
  const allSel = rows.filter(r => !r.dnc).length && rows.filter(r => !r.dnc).every(r => state.selection[r.c.dot]);
  const body = rows.map((r, i) => {
    const c = r.c, last = r.logs[0], warn = r.warns.length > 0;
    const cb = r.dnc ? '<td></td>' : '<td onclick="event.stopPropagation()"><label class="check"><input type="checkbox" ' + (state.selection[c.dot]?"checked":"") + ' data-change="selRow" data-dot="' + c.dot + '"><span class="box">' + icon("check") + "</span></label></td>";
    const statusCell = r.dnc ? '<td class="center">' + badge("dnc") + " " + icon("lock") + "</td>" :
      '<td class="center" onclick="event.stopPropagation()"><select class="select sm" style="width:126px;margin:0 auto;color:' + statusVar(r.status) + ';font-weight:700" data-change="rowStatus" data-dot="' + c.dot + '" data-batch="' + b.id + '">' + STATUS_ORDER.map(k => '<option value="' + k + '"' + sel(r.status,k) + ">" + STATUS[k].label + "</option>").join("") + '<option value="dnc">Do Not Call…</option></select></td>';
    // F46: one complete thought per line — outcome / time / callback each on their own line.
    const lastCell = last
      ? "<div class='lc-line'>" + icon(CHANNEL[last.channel||"call"].ic) + "<span>" + DISPO_LABEL[last.disposition] + "</span></div><div class='lc-sub'>" + fmtRel(last.at) + "</div>" + (last.callback_at ? "<div class='lc-sub' style='white-space:nowrap'>callback " + fmtRel(last.callback_at) + "</div>" : "")
      : "—";
    // F47: quick-log per channel.
    const quick = r.dnc ? "" : Object.keys(CHANNEL).map(ch => '<button class="btn icon sm" title="Log ' + CHANNEL[ch].label + '" data-act="logCall" data-dot="' + c.dot + '" data-batch="' + b.id + '" data-channel="' + ch + '">' + icon(CHANNEL[ch].ic) + "</button>").join("");
    return '<tr class="clickable ' + (warn ? "warn-row" : "") + (r.dnc ? " dnc" : "") + (state.selection[c.dot] ? " sel" : "") + '" data-act="openCarrier" data-dot="' + c.dot + '" data-from="' + b.id + '">' +
      cb +
      "<td>" + tagsFor(c) + "</td>" +
      "<td><div class='co'><span class='nm'>" + esc(c.legal_name) + "</span><span class='meta'>USDOT <span class='mono'>" + c.dot + "</span></span></div></td>" +
      "<td>" + contactCell(c) + "</td>" +
      "<td class='center'><div class='stack' style='align-items:center'><span>" + esc(c.city) + "</span>" + (r.dist!=null?"<span class='meta subtle mono'>"+r.dist.toFixed(0)+" mi</span>":"") + "</div></td>" +
      "<td class='mono center'>" + c.power_units + "</td>" +
      "<td>" + insBadge(c) + "</td>" +
      "<td>" + (warn ? warnChips(c.dot, true) : '<span class="subtle">—</span>') + "</td>" +
      statusCell +
      "<td class='muted center' style='font-size:12px'>" + lastCell + "</td>" +
      "<td class='right' style='white-space:nowrap'><span class='row gap-4'>" + quick + "</span></td></tr>";
  }).join("");
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr><th><label class="check"><input type="checkbox" ' + (allSel?"checked":"") + ' data-change="selAll"><span class="box">' + icon("check") + '</span></label></th><th style="min-width:86px">Tags</th><th style="min-width:200px">Carrier</th><th style="min-width:170px">Contact</th><th class="center">Location</th><th class="center">Trucks</th><th>Insurance</th><th style="min-width:150px">Warnings</th><th class="center">Status</th><th class="center" style="min-width:130px">Last contact</th><th></th></tr></thead><tbody>' + body + "</tbody></table></div>";
}
function bulkBar(n) {
  return '<div style="position:fixed;left:calc(var(--sidebar-w) + 24px);right:24px;bottom:20px;background:var(--text);color:var(--bg);border-radius:12px;padding:10px 12px 10px 18px;display:flex;align-items:center;gap:12px;box-shadow:var(--shadow-pop);z-index:30"><b class="mono">' + n + "</b> selected<div class=\"spacer\" style=\"flex:1\"></div>" +
    '<button class="btn sm" data-act="bulkStatus" data-s="contacted" style="background:transparent;color:var(--bg);border-color:rgba(255,255,255,.25)">Mark contacted</button>' +
    '<button class="btn sm" data-act="bulkStatus" data-s="interested" style="background:transparent;color:var(--bg);border-color:rgba(255,255,255,.25)">Mark interested</button>' +
    '<button class="btn primary sm" data-act="genContact">' + icon("send") + ' Generate Contact Options</button>' +
    '<button class="btn icon sm" data-act="clearSel" style="background:transparent;color:var(--bg);border-color:rgba(255,255,255,.25)">' + icon("x") + "</button></div>";
}

/* ------------------------------- CARRIER PROFILE (F7 — 3 variants) ------------------------------- */
function screenProfile() {
  const c = DB.carrierByDot[state.activeCarrierDot];
  if (!c) { state.screen = "dashboard"; return screenDashboard(); }
  const fromBatch = state.profileFromBatch ? DB.batches.find(b => b.id === state.profileFromBatch) : null;
  const crumbs = fromBatch ? [{ label:"Dashboard", act:"nav", to:"dashboard" }, { label:fromBatch.name, act:"openBatch", to:fromBatch.id }, { label:c.legal_name }] : [{ label:"Dashboard", act:"nav", to:"dashboard" }, { label:c.legal_name }];
  // F7 resolved: owner picked COMMAND CONSOLE. (Dossier/Ledger renderers retained
  // below for reference; reachable only via ACT.profVariant in dev tooling.)
  const inner = '<div class="page wide">' + (fromBatch ? '<a class="link row gap-6 center" style="margin-bottom:10px" data-act="openBatch" data-id="' + fromBatch.id + '">' + icon("chevL") + " Back to " + esc(fromBatch.name) + "</a>" : "") +
    (state.profileVariant === "dossier" ? profDossier(c, fromBatch) : state.profileVariant === "ledger" ? profLedger(c, fromBatch) : profConsole(c, fromBatch)) + "</div>";
  return appShell(inner, crumb(crumbs));
}
function idFacts(c) { return [c.entity, c.classdef, c.operation, c.power_units + " trucks / " + c.drivers + " drivers", "MCS-150 " + c.mcs150, c.street + ", " + c.city + ", TX " + c.zip]; }
function headerBadges(c, dnc) {
  return (c.tier===1?'<span class="badge tier1">Sand &amp; Gravel</span>':c.tier===2?'<span class="badge tier2">Tier 2</span>':'<span class="badge plain">No cargo match</span>') +
    (c.active?' <span class="badge good"><span class="dot"></span>Active</span>':' <span class="badge crit">Inactive</span>') +
    (dnc?' <span class="badge dnc">'+icon("lock")+" Do Not Call</span>":"");
}
function promoteBtn(c) { const pr = effPromoted(c.dot); return pr ? '<span class="badge good" style="height:34px;padding:0 12px">' + icon("check") + " Promoted</span>" : '<button class="btn primary" data-act="promote" data-dot="' + c.dot + '">' + icon("arrowR") + " Mark as Promoted</button>"; }
function verdictOf(c, kind) {
  const w = warningsFor(c);
  if (kind === "insurance") return w.includes("no_insurance")||w.includes("authority_not_active") ? "crit" : (w.includes("insurance_below_standard")||w.includes("insurance_expiring_30d")) ? "warn" : "good";
  if (kind === "safety") return w.includes("safety_rating") ? "crit" : (w.includes("high_oos")||w.includes("recent_crashes")) ? "warn" : (c.safety.rating==="Satisfactory"?"good":"plain");
  if (kind === "inspections") return c.inspections.some(x => x.result === "OOS") ? "warn" : (c.inspections.length ? "good" : "plain");
  return "plain";
}
function verificationTiles(c) {
  const iv = verdictOf(c,"insurance"), sv = verdictOf(c,"safety"), nv = verdictOf(c,"inspections");
  const vi = { good:"shieldcheck", warn:"alert", crit:"alert", plain:"shield" };
  return '<div class="vtiles">' +
    '<div class="vtile ' + iv + '"><div class="vhead"><span class="vic">' + icon(vi[iv]) + '</span><span class="vname">Insurance</span></div><div class="vbig">' + fmtMoney(c.ins.bipd_on_file) + '</div><div class="vsub">Authority ' + c.ins.authority_status + (c.ins.expiring_30d?" · expiring ≤30d":"") + '</div></div>' +
    '<div class="vtile ' + sv + '"><div class="vhead"><span class="vic">' + icon(vi[sv]) + '</span><span class="vname">Safety</span></div><div class="vbig">' + c.safety.rating + '</div><div class="vsub">' + c.safety.crash_total + ' crashes · ' + c.safety.vehicle_oos_pct + '% veh OOS</div></div>' +
    '<div class="vtile ' + nv + '"><div class="vhead"><span class="vic">' + icon(vi[nv]) + '</span><span class="vname">Inspections</span></div><div class="vbig">' + (c.inspections.length || c.safety.inspections_24mo) + '</div><div class="vsub">' + (c.inspections.length ? c.inspections.filter(x=>x.result==="OOS").length + " OOS on file" : "last 24 months") + '</div></div>' +
    "</div>";
}
function contactPanel(c, fromBatch, dnc) {
  const statusControl = dnc ? '<div class="badge dnc" style="height:32px">' + icon("lock") + " Do Not Call — outreach disabled</div>" :
    fromBatch ? '<select class="select" data-change="rowStatus" data-dot="' + c.dot + '" data-batch="' + fromBatch.id + '" style="font-weight:700;color:' + statusVar(effStatus(fromBatch.id,c.dot)) + '">' + STATUS_ORDER.map(k => '<option value="' + k + '"' + sel(effStatus(fromBatch.id,c.dot),k) + ">" + STATUS[k].label + "</option>").join("") + '<option value="dnc">Do Not Call…</option></select>' :
    '<div class="subtle" style="font-size:12px">Open from a batch to set a working status.</div>';
  const logBtns = dnc ? "" : '<div class="row gap-6 mt-8">' + Object.keys(CHANNEL).map(ch => '<button class="btn sm grow" data-act="logCall" data-dot="' + c.dot + '"' + (fromBatch?' data-batch="'+fromBatch.id+'"':"") + ' data-channel="' + ch + '">' + icon(CHANNEL[ch].ic) + " " + CHANNEL[ch].label + "</button>").join("") + "</div>";
  return '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px">Call workflow' + (fromBatch?' <span class="subtle">· '+esc(fromBatch.name)+"</span>":"") + "</div>" +
    '<div class="field" style="margin-bottom:8px"><span class="label">Status in this batch</span>' + statusControl + "</div>" + logBtns +
    '<div class="eyebrow" style="margin:16px 0 2px">Contact history <span class="subtle">· all batches</span></div>' + timeline(c) + "</div>";
}
function timeline(c) {
  const logs = logsForDot(c.dot);
  if (!logs.length) return '<div class="subtle" style="font-size:12.5px;padding:10px 0">No contact attempts logged yet.</div>';
  return logs.map(l => { const u = DB.userById[l.user_id], bt = DB.batches.find(b => b.id === l.batch_id), ch = CHANNEL[l.channel||"call"];
    return '<div class="row gap-10" style="padding:11px 0;border-top:1px solid var(--border)"><span class="feed-ic">' + icon(ch.ic) + '</span><div style="min-width:0;flex:1"><div class="row between center"><span class="badge ' + dispoCls(l.disposition) + '">' + ch.label + " · " + DISPO_LABEL[l.disposition] + '</span><span class="subtle mono" style="font-size:11px">' + fmtRel(l.at) + "</span></div>" +
    (l.notes?'<div style="font-size:12.5px;margin-top:5px">'+esc(l.notes)+"</div>":"") + (l.next_steps?'<div class="subtle" style="font-size:11.5px;margin-top:3px">Next: '+esc(l.next_steps)+"</div>":"") +
    '<div class="subtle" style="font-size:11px;margin-top:4px">' + esc(u?u.name.split(" ")[0]:"") + (bt?" · "+esc(bt.name):"") + "</div></div></div>"; }).join("");
}
function dispoCls(d) { return ["connected","interested","replied"].includes(d) ? "good" : ["no_answer","wrong_number","not_interested","bounced","no_response"].includes(d) ? "plain" : "warn"; }
function memberships(c) {
  const mems = DB.batchCarriers.filter(b => b.dot === c.dot);
  if (!mems.length) return "";
  return '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px">In these batches <span class="subtle">· ' + mems.length + "</span></div>" +
    mems.map(m => { const b = DB.batches.find(x => x.id === m.batch_id); return '<button class="mem-row row between center" data-act="openBatchCarrier" data-batch="' + b.id + '" data-dot="' + c.dot + '"><span style="font-size:13px;font-weight:600;text-align:left">' + esc(b.name) + "</span>" + (effDnc(c.dot)?badge("dnc"):badge(effStatus(b.id,c.dot))) + "</button>"; }).join("") +
    '<div class="subtle" style="font-size:11px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">Status is tracked <b>per batch</b>.</div></div>';
}
function researchLinks(c) {
  const gq = encodeURIComponent('"' + c.legal_name + '" ' + c.city + ' TX trucking');
  const links = [
    ["search", "Google the company", "https://www.google.com/search?q=" + gq],
    ["pin", "Google Maps / Business", "https://www.google.com/maps/search/" + encodeURIComponent(c.legal_name + " " + c.city + " TX")],
    ["shield", "FMCSA SAFER snapshot", "https://safer.fmcsa.dot.gov/query.asp?query_type=queryCarrierSnapshot&query_param=USDOT&query_string=" + c.dot],
    ["building", "TX SOS business search", "https://www.sos.state.tx.us/corp/sosda/"]
  ];
  if (c.contact_name) { const cq = encodeURIComponent('"' + c.contact_name + '" ' + c.legal_name); links.splice(1, 0, ["users", "Search contact: " + c.contact_name, "https://www.google.com/search?q=" + cq]); }
  return '<div class="card" style="padding:16px"><div class="eyebrow" style="margin-bottom:4px">Research <span class="subtle">· enrichment coming later</span></div><div class="subtle" style="font-size:11.5px;margin-bottom:10px">Prefilled searches to find a website, socials, or a better contact.</div><div class="stack gap-6">' +
    links.map(l => '<a class="rlink" href="' + l[2] + '" target="_blank" rel="noopener">' + icon(l[0]) + esc(l[1]) + '<span class="ext">' + icon("external") + "</span></a>").join("") + "</div></div>";
}
function contactStrip(c) {
  return '<div class="row gap-8 wrap">' +
    '<span class="badge plain" style="height:30px">' + icon("phone") + " " + esc(c.phone) + "</span>" +
    (c.cell?'<span class="badge plain" style="height:30px">'+esc(c.cell)+" (cell)</span>":"") +
    (c.contact_name?'<span class="badge plain" style="height:30px">'+icon("users")+" "+esc(c.contact_name)+"</span>":"") +
    (c.email?'<span class="badge plain" style="height:30px">'+icon("mail")+" "+esc(c.email)+"</span>":'<span class="badge crit" style="height:30px">'+icon("mail")+" no email</span>") + "</div>";
}
function dncToggle(c, dnc) { return '<label class="switch danger"><input type="checkbox" ' + (dnc?"checked":"") + ' data-act="toggleDnc" data-dot="' + c.dot + '"><span class="track"></span><span><b>Do Not Call</b> <span class="subtle">— global, every batch &amp; channel</span></span></label>'; }
/* --- variant: Command Console --- */
function profConsole(c, fromBatch) {
  const dnc = effDnc(c.dot), warn = warningsFor(c).length > 0;
  const header = '<div class="card ' + (warn?"":"") + '" style="padding:18px 20px;margin-bottom:16px' + (warn?";background:var(--crit-tint);border-color:color-mix(in srgb,var(--crit) 25%,var(--border))":"") + '"><div class="row between wrap gap-12" style="align-items:flex-start"><div style="min-width:0"><div class="row gap-10 center wrap"><h1 style="font-size:22px;font-weight:800">' + esc(c.legal_name) + "</h1>" + headerBadges(c, dnc) + '</div><div class="row gap-16 mt-8 muted" style="font-size:13px;flex-wrap:wrap"><span>USDOT <b class="mono" style="color:var(--text)">' + c.dot + "</b></span>" + (c.dba?"<span>DBA "+esc(c.dba)+"</span>":"") + idFacts(c).slice(0,3).map(f => "<span>"+esc(f)+"</span>").join("") + "</div>" + (warn ? '<div class="wchips mt-8">' + warnChips(c.dot) + "</div>" : "") + "</div>" + promoteBtn(c) + "</div></div>";
  return header + '<div class="console-grid"><div class="console-rail">' + contactPanel(c, fromBatch, dnc) + '<div class="card" style="padding:16px">' + dncToggle(c, dnc) + "</div>" + researchLinks(c) + "</div><div class=\"stack gap-16\">" + verificationTiles(c) + generalCard(c) + memberships(c) + "</div></div>";
}
function generalCard(c) {
  return '<div class="card" style="padding:18px"><div class="eyebrow" style="margin-bottom:12px">Carrier detail</div><dl class="kv">' +
    [["Legal name",esc(c.legal_name)],["DBA",c.dba?esc(c.dba):"—"],["Cargo (Other)",c.cargoOther?'<span class="badge tier1">"'+esc(c.cargoOther)+'"</span>':"—"],["Cargo flags",c.cargoFlags.filter(f=>f!=="Other").map(f=>'<span class="badge plain">'+esc(f)+"</span>").join(" ")||"—"],["Operation",c.operation],["Classification",c.classdef],["Power units",'<span class="mono">'+c.power_units+"</span>"],["Drivers",'<span class="mono">'+c.drivers+"</span>"],["Address",esc(c.street+", "+c.city+", TX "+c.zip)]].map(r => "<dt>"+r[0]+"</dt><dd>"+r[1]+"</dd>").join("") + "</dl></div>";
}
/* --- variant: Dossier --- */
function profDossier(c, fromBatch) {
  const dnc = effDnc(c.dot);
  const stampOf = (kind, name, big) => { const v = verdictOf(c, kind); return '<div class="stamp ' + v + '"><div class="st">' + name + '</div><div class="sv">' + big + "</div></div>"; };
  const head = '<div class="dossier-head"><div class="wm">' + c.dot + '</div><div style="position:relative"><h1>' + esc(c.legal_name) + '</h1><div class="row gap-8 mt-8">' + headerBadges(c, dnc) + '</div><div class="dfacts">' + idFacts(c).map(f => "<span>"+esc(f)+"</span>").join("") + "</div></div></div>";
  const stamps = '<div class="stamp-row mt-16">' + stampOf("insurance","Insurance",fmtMoney(c.ins.bipd_on_file)) + stampOf("safety","Safety",c.safety.rating) + stampOf("inspections","Inspections",(c.inspections.length||c.safety.inspections_24mo)) + "</div>";
  return head + stamps + '<div style="max-width:760px;margin:16px auto 0"><div class="card" style="padding:16px;margin-bottom:16px"><div class="row between center wrap gap-10">' + contactStrip(c) + "<div class=\"row gap-8\">" + promoteBtn(c) + "</div></div><div style=\"margin-top:12px;padding-top:12px;border-top:1px solid var(--border)\">" + dncToggle(c, dnc) + "</div></div>" + contactPanel(c, fromBatch, dnc) + '<div class="mt-16">' + researchLinks(c) + '</div><div class="mt-16">' + memberships(c) + "</div></div>";
}
/* --- variant: Verification Ledger --- */
function profLedger(c, fromBatch) {
  const dnc = effDnc(c.dot);
  const row = (kind, name, big, sub) => { const v = verdictOf(c, kind); const vi = { good:"shieldcheck", warn:"alert", crit:"alert", plain:"shield" }; return '<div class="ledger-row ' + v + '"><span class="ledger-verdict">' + icon(vi[v]) + '</span><div style="flex:1"><div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-subtle)">' + name + '</div><div style="font-size:16px;font-weight:800;margin-top:2px">' + big + '</div><div class="subtle" style="font-size:12px">' + sub + "</div></div></div>"; };
  const contactRow = (function(){ const has = (c.phone||c.cell) && c.email && c.contact_name; const v = has?"good":(c.phone||c.cell)?"warn":"crit"; return '<div class="ledger-row ' + v + '"><span class="ledger-verdict">' + icon("phone") + '</span><div style="flex:1"><div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-subtle)">Contactability</div><div style="margin-top:4px">' + contactStrip(c) + "</div></div></div>"; })();
  const authV = c.ins.authority_status === "active" ? "good" : "crit";
  const head = '<div class="card" style="padding:16px 20px;margin-bottom:14px"><div class="row between wrap gap-12" style="align-items:flex-start"><div><div class="row gap-10 center wrap"><h1 style="font-size:20px;font-weight:800">' + esc(c.legal_name) + "</h1>" + headerBadges(c, dnc) + '</div><div class="muted" style="font-size:13px;margin-top:6px">USDOT <b class="mono" style="color:var(--text)">' + c.dot + "</b> · " + esc(c.city) + ", TX · " + c.power_units + " trucks</div></div>" + promoteBtn(c) + "</div></div>";
  return head + '<div class="console-grid"><div class="ledger">' +
    contactRow +
    row("insurance","Insurance","BIPD " + fmtMoney(c.ins.bipd_on_file), "Required " + fmtMoney(c.ins.bipd_required) + " · effective " + c.ins.effective) +
    ('<div class="ledger-row ' + authV + '"><span class="ledger-verdict">' + icon("shield") + '</span><div style="flex:1"><div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-subtle)">Authority</div><div style="font-size:16px;font-weight:800;margin-top:2px">' + c.ins.authority_status + '</div><div class="subtle" style="font-size:12px">' + c.ins.authority_type + " authority</div></div></div>") +
    row("safety","Safety",c.safety.rating + " rating", c.safety.crash_total + " crashes · " + c.safety.vehicle_oos_pct + "% veh / " + c.safety.driver_oos_pct + "% drv OOS") +
    row("inspections","Inspections",(c.inspections.length||c.safety.inspections_24mo) + " on file", c.inspections.length ? c.inspections.filter(x=>x.result==="OOS").length + " out-of-service" : "no detail on file") +
    '<div class="card" style="padding:14px 16px">' + dncToggle(c, dnc) + "</div>" +
    "</div><div class=\"console-rail\">" + contactPanel(c, fromBatch, dnc) + researchLinks(c) + memberships(c) + "</div></div>";
}

/* ------------------------------- USERS ------------------------------- */
function userRow(u) { const ov = state.overrides.userStatus[u.id]; return { u, status: ov?ov.status:u.status, role: ov?ov.role:u.role }; }
function screenUsers() {
  if (cur().role !== "manager") { state.screen = "dashboard"; return screenDashboard(); }
  const all = DB.users.map(userRow), pending = all.filter(r => r.status === "pending"), active = all.filter(r => r.status !== "pending");
  const inner = '<div class="page"><div class="page-head"><div><div class="h1">Users &amp; Access</div></div></div>' +
    (pending.length ? '<div class="card" style="padding:16px;margin-bottom:18px;border-color:var(--warn)"><div class="row gap-8 center" style="margin-bottom:12px">' + icon("clock") + '<b>Pending approval</b><span class="badge warn">' + pending.length + "</span></div>" +
      pending.map(r => '<div class="row between center wrap gap-10" style="padding:10px 0;border-top:1px solid var(--border)"><div class="row gap-10 center">' + avatar(r.u) + "<div><div style='font-weight:700'>" + esc(r.u.name) + "</div><div class='subtle' style='font-size:12px'>" + esc(r.u.email) + " · " + fmtRel(r.u.registered) + "</div></div></div><div class='row gap-8'><button class='btn sm' data-act='rejectUser' data-uid='" + r.u.id + "'>Reject</button><button class='btn primary sm' data-act='approveUser' data-uid='" + r.u.id + "'>" + icon("usercheck") + " Approve</button></div></div>").join("") + "</div>" : "") +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' +
      active.map(r => "<tr><td><div class='row gap-10 center'>" + avatar(r.u,28) + "<span style='font-weight:700'>" + esc(r.u.name) + "</span></div></td><td class='muted'>" + esc(r.u.email) + "</td><td>" + (r.u.id==="u_manager"?'<span class="badge tier1">Manager</span>':'<select class="select sm" style="width:110px" data-change="setRole" data-uid="'+r.u.id+'"><option value="edit"'+sel(r.role,"edit")+">Editor</option><option value=\"view\""+sel(r.role,"view")+">Viewer</option><option value=\"manager\""+sel(r.role,"manager")+">Manager</option></select>") + "</td><td>" + (r.status==="suspended"?'<span class="badge crit">Suspended</span>':'<span class="badge good"><span class="dot"></span>Approved</span>') + "</td><td class='right'>" + (r.u.id==="u_manager"?'<span class="subtle" style="font-size:12px">you</span>':'<button class="btn sm danger" data-act="suspendUser" data-uid="'+r.u.id+'">'+(r.status==="suspended"?"Restore":"Suspend")+"</button>") + "</td></tr>").join("") +
    "</tbody></table></div></div>";
  return appShell(inner, crumb([{ label:"Users" }]));
}

/* ------------------------------- MENUS ------------------------------- */
const MENUS = {
  userMenu: () => { const u = cur(); return '<div style="padding:8px 10px"><div style="font-weight:700">' + esc(u.name) + '</div><div class="subtle" style="font-size:12px">' + esc(u.email) + " · " + ROLE_LABEL[u.role] + "</div></div><div class='sep'></div><button data-act=\"logout\">" + icon("logout") + " Sign out</button>"; },
  batchMenu: (m) => '<button data-act="renameBatch" data-id="' + m.id + '">' + icon("edit") + ' Rename</button><button data-act="refreshBatch" data-id="' + m.id + '">' + icon("refresh") + " Refresh members</button><div class='sep'></div><button class=\"danger\" data-act=\"deleteBatch\" data-id=\"" + m.id + "\">" + icon("trash") + " Delete batch</button>"
};

/* ------------------------------- MODALS ------------------------------- */
const MODALS = {
  dnc: (m) => modalWrap("Set Do Not Call?", "lock", "<p>This flags <b>" + esc(DB.carrierByDot[m.dot].legal_name) + "</b> as <b>Do Not Call</b> — a <b>global</b> suppression across <b>every batch</b> and all channels (call, text, email, mail).</p>", '<button class="btn" data-act="closeModal">Cancel</button><button class="btn danger" data-act="confirmDnc" data-dot="' + m.dot + '">' + icon("lock") + " Set Do Not Call</button>"),
  undnc: (m) => modalWrap("Clear Do Not Call?", "check", "<p>Re-enable contact for <b>" + esc(DB.carrierByDot[m.dot].legal_name) + "</b> across all batches?</p>", '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="confirmUndnc" data-dot="' + m.dot + '">Clear flag</button>'),
  promote: (m) => modalWrap("Mark as Promoted?", "arrowR", "<p>Records that <b>" + esc(DB.carrierByDot[m.dot].legal_name) + "</b> (USDOT <span class='mono'>" + m.dot + "</span>) asked to register and was promoted into the TNBS tools. <b>Nothing is sent anywhere</b> — this is a tracking flag; you add the USDOT to your other tools yourself.</p>", '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="confirmPromote" data-dot="' + m.dot + '">' + icon("check") + " Mark as Promoted</button>"),
  rename: (m) => modalWrap("Rename batch", "edit", '<label class="field"><span class="label">Batch name</span><input class="input" id="rename-input" value="' + esc(DB.batches.find(b => b.id === m.id).name) + '"></label>', '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="confirmRename" data-id="' + m.id + '">Save</button>'),
  del: (m) => modalWrap("Delete batch?", "trash", "<p>Delete <b>" + esc(DB.batches.find(b => b.id === m.id).name) + "</b> and its working statuses? Carriers stay in your database and other batches.</p>", '<button class="btn" data-act="closeModal">Cancel</button><button class="btn danger" data-act="confirmDelete" data-id="' + m.id + '">Delete batch</button>'),
  refresh: (m) => modalWrap("Batch refreshed", "refresh", "<p>Re-ran the saved search. <b>" + m.added + " new</b> carrier" + (m.added===1?"":"s") + " matched since the snapshot and " + (m.added?"were added":"nothing changed") + ". Existing members and statuses were kept.</p>", '<button class="btn primary" data-act="closeModal">Done</button>'),
  log: (m) => {
    const c = DB.carrierByDot[m.dot], ch = m.channel || "call";
    const chSeg = Object.keys(CHANNEL).map(k => '<button type="button" class="' + (ch===k?"on":"") + '" data-act="logChannel" data-dot="' + m.dot + '"' + (m.batch?' data-batch="'+m.batch+'"':"") + ' data-channel="' + k + '">' + icon(CHANNEL[k].ic) + " " + CHANNEL[k].label + "</button>").join("");
    return modalWrap("Log outreach — " + esc(c.legal_name), CHANNEL[ch].ic,
      '<div class="seg" style="width:100%;margin-bottom:14px">' + chSeg + "</div>" +
      '<div class="row gap-16 mt-4" style="margin-bottom:12px"><span class="badge plain" style="height:30px">' + icon("phone") + " " + esc(c.phone) + "</span>" + (c.email?'<span class="badge plain" style="height:30px">'+icon("mail")+" "+esc(c.email)+"</span>":"") + "</div>" +
      '<div class="stack gap-12"><div class="field"><span class="label">Outcome</span><select class="select" id="log-dispo">' + DISPO_BY_CHANNEL[ch].map(d => '<option value="' + d + '">' + DISPO_LABEL[d] + "</option>").join("") + "</select></div>" +
      '<div class="field"><span class="label">Notes</span><textarea class="textarea" id="log-notes" placeholder="What was said…"></textarea></div>' +
      '<div class="field"><span class="label">Next steps</span><input class="input" id="log-next" placeholder="e.g. Send rate sheet"></div>' +
      (m.batch ? '<div class="field"><span class="label">Update status in this batch to</span><select class="select" id="log-status"><option value="">— leave unchanged —</option>' + STATUS_ORDER.map(k => '<option value="' + k + '">' + STATUS[k].label + "</option>").join("") + "</select></div>" : "") + "</div>",
      '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="submitLogBtn">' + icon("check") + " Save</button>");
  },
  contact: (m) => {
    const rows = m.dots.map(d => DB.carrierByDot[d]);
    const withPhone = rows.filter(r => r.phone||r.cell).length, withEmail = rows.filter(r => r.email).length, withName = rows.filter(r => r.contact_name).length;
    return modalWrapLg("Generate Contact Options", "send",
      '<div class="row gap-10 wrap" style="margin-bottom:14px"><span class="badge info" style="height:28px"><b class="mono">' + rows.length + '</b>&nbsp;carriers</span><span class="badge good" style="height:28px">' + icon("phone") + " " + withPhone + ' phone</span><span class="badge ' + (withName?"good":"plain") + '" style="height:28px">' + icon("users") + " " + withName + ' names</span><span class="badge ' + (withEmail?"warn":"plain") + '" style="height:28px">' + icon("mail") + " " + withEmail + ' email</span></div>' +
      '<div class="tbl-wrap" style="max-height:300px;overflow-y:auto"><table class="tbl"><thead><tr><th>Carrier</th><th>Contact name</th><th>Phone</th><th>Email</th><th>Status</th></tr></thead><tbody>' +
        rows.map(r => "<tr><td style='font-weight:600'>" + esc(r.legal_name) + "</td><td>" + (r.contact_name?esc(r.contact_name):'<span class="subtle">—</span>') + "</td><td class='mono'>" + esc(r.phone||"—") + "</td><td>" + (r.email?esc(r.email):'<span class="subtle">—</span>') + "</td><td>" + (state.activeBatchId?badge(effStatus(state.activeBatchId,r.dot)):"") + "</td></tr>").join("") + "</tbody></table></div>" +
      '<div class="row wrap gap-8 mt-16"><button class="btn" data-act="exportSheet" data-kind="print"' + (m.batch?' data-batch="'+m.batch+'"':"") + '>' + icon("printer") + ' Print call sheet</button><button class="btn" data-act="exportSheet" data-kind="csv"' + (m.batch?' data-batch="'+m.batch+'"':"") + '>' + icon("download") + ' Export CSV</button></div>' +
      '<div class="demo-note mt-16">Contact name &amp; email are included (F9). Do-Not-Call carriers are auto-excluded. Email &amp; text blasts arrive in the next phase — this Phase-1 step produces the sheet your team works.</div>',
      '<button class="btn primary" data-act="closeModal">Done</button>');
  },
  approve: (m) => { const u = DB.userById[m.uid]; return modalWrap("Approve " + esc(u.name), "usercheck", "<p>Give <b>" + esc(u.name) + "</b> access and assign a role:</p><div class='stack gap-8 mt-12'><label class='check' style='padding:10px;border:1px solid var(--border);border-radius:8px'><input type='radio' name='approle' value='edit' checked><span class='box'>" + icon("check") + "</span><span><b>Editor</b> — search, work lists, log outreach</span></label><label class='check' style='padding:10px;border:1px solid var(--border);border-radius:8px'><input type='radio' name='approle' value='view'><span class='box'>" + icon("check") + "</span><span><b>Viewer</b> — read-only</span></label></div>", '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="confirmApprove" data-uid="' + m.uid + '">Approve &amp; provision</button>'); }
};
function modalWrap(title, ic, body, foot) { return '<div class="scrim" data-act="closeModal"><div class="modal"><div class="modal-head">' + icon(ic) + '<span class="t">' + esc(title) + '</span></div><div class="modal-body">' + body + '</div><div class="modal-foot">' + foot + "</div></div></div>"; }
function modalWrapLg(title, ic, body, foot) { return '<div class="scrim" data-act="closeModal"><div class="modal lg"><div class="modal-head">' + icon(ic) + '<span class="t">' + esc(title) + '</span></div><div class="modal-body">' + body + '</div><div class="modal-foot">' + foot + "</div></div></div>"; }
