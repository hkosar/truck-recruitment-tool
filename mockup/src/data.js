/* ============================================================================
   data.js — seeded, deterministic mock dataset v2 (stable across reloads).
   Mirrors the future Supabase schema (docs/build-plan/01-architecture.md).
   Nothing here is real; all carriers/contacts are fabricated for the prototype.
   ============================================================================ */

const NOW_MS = Date.parse("2026-07-15T15:00:00Z");
const DAY = 86400000, HOUR = 3600000;

/* mulberry32 — tiny seeded PRNG so the demo data never shifts under you. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260715);
const rnd = (a, b) => a + rng() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;

const GEO = ["Lone Star","Brazos","Permian","Hill Country","Trinity","Bluebonnet","Caprock",
  "Guadalupe","Red River","Pecos","Comal","Frio","Balcones","Llano","Nueces","Alamo","Big Bend",
  "Gulf Coast","Panhandle","Rio Grande","San Jacinto","Cross Timbers","Edwards","Blanco","Colorado River"];
const SG_CORE = ["Aggregate","Sand & Gravel","Rock","Materials","Dirt Works","Gravel","Aggregates",
  "Sand Co.","Rock & Sand","Stone","Base Material"];
const T2_CORE = ["Construction","Dump Truck","Excavation","Ready Mix","Concrete","Building Supply","Site Works"];
const T0_CORE = ["Logistics","Refrigerated","Tank Lines","Livestock","Van Lines","Distribution","Freightways"];
const SUFFIX = ["Trucking","Transport","Hauling","Logistics","Carriers","Express","LLC","Inc."];
// Distinct free-text "Other cargo" values (messy, real-world) — the F14 facet backbone.
const SG_OTHER = ["Sand and Gravel","Sand & Gravel","SAND/GRAVEL","Rock & Dirt","Aggregate Hauling","Gravel",
  "Sand, Gravel, Rock","Dirt & Aggregate","Crushed Stone","Fill Dirt / Sand","Sand and gravel hauling",
  "S&G Hauling","Rock, Sand, Base","aggregate / dirt","Caliche & Base","Topsoil / Fill","Frac Sand","Flex Base"];
const T2_OTHER = ["Base rock","Materials","Construction debris","Concrete washout","Rip Rap"];
const FIRST = ["James","Robert","Miguel","David","Carlos","John","Jose","Michael","Daniel","Ray","Tommy","Wade",
  "Luis","Chris","Kevin","Brandon","Cody","Hector","Travis","Dustin","Juan","Marcus","Shane","Earl"];
const LAST = ["Garcia","Martinez","Smith","Rodriguez","Johnson","Hernandez","Williams","Lopez","Gonzalez","Davis",
  "Perez","Sanchez","Ramirez","Torres","Flores","Rivera","Gomez","Cooper","Reyes","Bennett","Cruz","Morgan"];
const STREETS = ["Farm to Market Rd","County Rd","Industrial Blvd","Quarry Rd","Old Bastrop Hwy","Pit Rd",
  "Commerce St","Aggregate Way","Loop","Business Park Dr","Ranch Rd","Highway 90"];
const AREA_BY_CITY = { "Houston":"713","San Antonio":"210","Austin":"512","Dallas":"214","Fort Worth":"817",
  "El Paso":"915","Midland":"432","Odessa":"432","Lubbock":"806","Laredo":"956","Corpus Christi":"361",
  "Amarillo":"806","Waco":"254","Beaumont":"409" };
const CITY_WEIGHTS = [["Houston",22],["Dallas",18],["Fort Worth",10],["San Antonio",16],["Austin",18],
  ["Midland",12],["Odessa",8],["Corpus Christi",8],["Laredo",7],["Lubbock",6],["Waco",12],["Amarillo",5],
  ["El Paso",5],["Beaumont",5]];
const CITY_PICK = CITY_WEIGHTS.flatMap(([c, w]) => Array(w).fill(c));
const cityOf = (name) => CITIES.find(c => c.name === name);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);

// The 30 FMCSA cargo categories (+ Other) — F14 plain checkboxes.
const CARGO_FLAGS = ["General Freight","Household Goods","Metal: sheets, coils, rolls","Motor Vehicles",
  "Drive/Tow away","Logs, Poles, Beams, Lumber","Building Materials","Mobile Homes","Machinery, Large Objects",
  "Fresh Produce","Liquids/Gases","Intermodal Cont.","Passengers","Oilfield Equipment","Livestock",
  "Grain, Feed, Hay","Coal/Coke","Meat","Garbage/Refuse","US Mail","Chemicals","Commodities Dry Bulk",
  "Refrigerated Food","Beverages","Paper Products","Utilities","Agricultural/Farm Supplies","Construction",
  "Water Well","Other"];

function phone(area) { return "(" + area + ") " + rndInt(200,989) + "-" + String(rndInt(1000,9999)); }
function bipdPick() {
  const r = rng();
  if (r < 0.10) return 0;
  if (r < 0.28) return 500000;
  if (r < 0.45) return 750000;
  if (r < 0.82) return 1000000;
  return 2000000;
}

function makeCarrier(i) {
  const r = rng();
  const tier = r < 0.60 ? 1 : (r < 0.90 ? 2 : 0);
  const cityName = pick(CITY_PICK);
  const c0 = cityOf(cityName);
  const lng = c0.lng + rnd(-0.55, 0.55);
  const lat = c0.lat + rnd(-0.45, 0.45);
  const geo = pick(GEO);
  let legal, cargoOther = null, flags = [];
  if (tier === 1) {
    legal = geo + " " + pick(SG_CORE) + (chance(0.45) ? " " + pick(SUFFIX) : "");
    cargoOther = pick(SG_OTHER);
    flags = ["Commodities Dry Bulk"];
    if (chance(0.6)) flags.push("Construction");
    if (chance(0.4)) flags.push("Building Materials");
    flags.push("Other");
  } else if (tier === 2) {
    legal = geo + " " + pick(T2_CORE) + " " + pick(SUFFIX);
    flags = pick([["Commodities Dry Bulk","Construction"], ["Construction","Building Materials"],
                  ["Building Materials"], ["Commodities Dry Bulk"]]).slice();
    if (chance(0.35)) { cargoOther = pick(T2_OTHER); flags.push("Other"); }
  } else {
    legal = geo + " " + pick(T0_CORE) + " " + pick(SUFFIX);
    flags = pick([["General Freight"], ["Refrigerated Food"], ["Liquids/Gases"], ["Livestock"],
                  ["Motor Vehicles"], ["General Freight","Building Materials"]]).slice();
  }
  const units = Math.min(90, Math.max(1, Math.round(Math.abs(rnd(-6, 1)) ** 1.7 * 8) + rndInt(1, 4)));
  const dnc = tier !== 0 && chance(0.02);
  const area = AREA_BY_CITY[cityName] || "512";
  const hasEmail = chance(0.24);
  const authority = (function(){ const a = rng(); return a < 0.72 ? "active" : (a < 0.9 ? "pending" : "inactive"); })();
  const bipd = bipdPick();
  const expiring = bipd > 0 && chance(0.06);
  const crashes = chance(0.7) ? 0 : rndInt(1, 6);
  const voos = Math.round(rnd(0, 42));
  const doos = Math.round(rnd(0, 22));
  const rating = (function(){ const a = rng(); return a < 0.55 ? "None" : (a < 0.9 ? "Satisfactory" : "Conditional"); })();
  const hasContact = chance(0.66);

  return {
    dot: 1200000 + i * 137 + rndInt(0, 130),
    legal_name: legal,
    dba: chance(0.25) ? geo + " " + pick(["S&G","Aggregates","Hauling","Materials"]) : null,
    tier,
    cargoOther,                                   // raw "Other" free-text (null if none)
    cargo_other_norm: cargoOther,                 // normalized facet value (kept readable for the demo)
    cargoFlags: flags,
    contact_name: hasContact ? pick(FIRST) + " " + pick(LAST) : null,   // F17 officer/contact (company_officer_1)
    city: cityName, state: "TX",
    zip: String(rndInt(75001, 79999)),
    street: rndInt(100, 9800) + " " + pick(STREETS),
    lng, lat,
    phone: phone(area),
    cell: chance(0.55) ? phone(area) : null,
    email: hasEmail ? (chance(0.5) ? "dispatch@" : "info@") + slug(legal) + ".com" : null,
    fax: chance(0.15) ? phone(area) : null,
    power_units: units,
    drivers: units + rndInt(0, 3),
    classdef: chance(0.82) ? "Authorized For Hire" : (chance(0.5) ? "Private (Property)" : "Exempt For Hire"),
    operation: chance(0.7) ? "Interstate" : "Intrastate (Non-HM)",
    active: chance(0.92),
    mcs150: fmtDate(NOW_MS - rndInt(20, 1400) * DAY),
    entity: "Carrier",
    ins: {
      authority_status: authority,
      authority_type: pick(["Common","Contract","Common"]),
      bipd_on_file: bipd,
      bipd_required: 750000,
      cargo_on_file: chance(0.6) ? 100000 : 0,
      effective: fmtDate(NOW_MS - rndInt(30, 900) * DAY),
      expiring_30d: expiring,
      cancel_date: expiring ? fmtDate(NOW_MS + rndInt(3, 29) * DAY) : null
    },
    safety: {
      crash_total: crashes,
      inspections_24mo: rndInt(0, 40),
      vehicle_oos_pct: voos,
      driver_oos_pct: doos,
      rating,
      rating_date: fmtDate(NOW_MS - rndInt(60, 1600) * DAY)
    },
    inspections: [],
    do_not_contact: dnc,
    dnc_reason: dnc ? pick(["Asked not to be contacted","Retired / sold trucks","Works exclusively w/ competitor"]) : null,
    dnc_by: dnc ? "u_manager" : null,
    dnc_at: dnc ? NOW_MS - rndInt(4, 90) * DAY : null
  };
}

function fmtDate(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth()+1).padStart(2,"0") + "-" + String(d.getUTCDate()).padStart(2,"0");
}

/* ---- warnings (F15/G5) — closed 9-code vocabulary, computed live everywhere ---- */
const WARN = {
  carrier_inactive:        { label:"Inactive registration", tone:"crit" },
  no_insurance:            { label:"No insurance on file",  tone:"crit" },
  insurance_below_standard:{ label:"BIPD below $1MM",       tone:"warn" },
  insurance_expiring_30d:  { label:"Insurance expiring ≤30d", tone:"warn" },
  authority_not_active:    { label:"Authority not active",  tone:"crit" },
  safety_rating:           { label:"Conditional rating",    tone:"crit" },
  high_oos:                { label:"High out-of-service",    tone:"warn" },
  recent_crashes:          { label:"Recent crashes",        tone:"warn" },
  missing_from_source:     { label:"Missing from FMCSA",     tone:"warn" }
};
function warningsFor(c) {
  const w = [];
  if (!c.active) w.push("carrier_inactive");
  if (c.ins.bipd_on_file === 0) w.push("no_insurance");
  else if (c.ins.bipd_on_file < 1000000) w.push("insurance_below_standard");
  if (c.ins.expiring_30d) w.push("insurance_expiring_30d");
  if (c.ins.authority_status !== "active" && c.ins.bipd_on_file > 0) w.push("authority_not_active");
  if (c.safety.rating === "Conditional" || c.safety.rating === "Unsatisfactory") w.push("safety_rating");
  if (c.safety.vehicle_oos_pct > 34 || c.safety.driver_oos_pct > 10) w.push("high_oos");
  if (c.safety.crash_total >= 4) w.push("recent_crashes");
  return w;
}

/* ---- build carriers ---- */
const carriers = [];
for (let i = 0; i < 220; i++) carriers.push(makeCarrier(i));
const carrierByDot = {};
carriers.forEach(c => carrierByDot[c.dot] = c);

function seedInspections(c, n) {
  for (let k = 0; k < n; k++) {
    c.inspections.push({
      date: fmtDate(NOW_MS - rndInt(20, 700) * DAY),
      state: "TX", level: "Level " + pick(["I","II","III"]),
      result: chance(0.7) ? "Clean" : "OOS", violations: chance(0.7) ? 0 : rndInt(1, 4)
    });
  }
}

/* ---- cargo "Other" facet values with counts (F14/G8) ---- */
const SG_GROUPS = { sand:"Sand", gravel:"Gravel", rock:"Rock", dirt:"Dirt", aggregate:"Aggregate", base:"Base", stone:"Stone", caliche:"Caliche", topsoil:"Topsoil", frac:"Frac sand" };
function otherGroup(v) {
  const s = v.toLowerCase();
  for (const k in SG_GROUPS) if (s.includes(k)) return SG_GROUPS[k];
  return null;
}
const cargoOtherValues = (function () {
  const m = {};
  carriers.forEach(c => { if (c.cargo_other_norm) { const v = c.cargo_other_norm; (m[v] = m[v] || { value: v, count: 0, group: otherGroup(v), is_sg: !!otherGroup(v) }).count++; } });
  return Object.values(m).sort((a, b) => b.count - a.count);
})();
const SG_OTHER_VALUES = cargoOtherValues.filter(v => v.is_sg).map(v => v.value);

/* ---- users ---- */
const users = [
  { id:"u_manager", name:"Hunter Kosar",   email:"hunter@twistednail.com", role:"manager", status:"approved", color:"#111418", registered: NOW_MS - 120*DAY },
  { id:"u_edit1",   name:"Marisol Vega",   email:"marisol@twistednail.com", role:"edit",    status:"approved", color:"#35547e", registered: NOW_MS - 96*DAY },
  { id:"u_edit2",   name:"Dwight Fowler",  email:"dwight@twistednail.com",  role:"edit",    status:"approved", color:"#3a4757", registered: NOW_MS - 54*DAY },
  { id:"u_view1",   name:"Priya Nair",     email:"priya@twistednail.com",   role:"view",    status:"approved", color:"#6b7482", registered: NOW_MS - 30*DAY },
  { id:"u_guest1",  name:"Cole Ramirez",   email:"cole.r@gmail.com",        role:"guest",   status:"pending",  color:"#8a5a2b", registered: NOW_MS - 2*DAY },
  { id:"u_guest2",  name:"Tanya Brooks",   email:"tbrooks@haulpro.co",      role:"guest",   status:"pending",  color:"#5a6b7a", registered: NOW_MS - 6*HOUR }
];
const userById = {}; users.forEach(u => userById[u.id] = u);
const WORKERS = ["u_manager","u_edit1","u_edit2"];

/* ---- search matching v2 (multi-lane union + facet cargo + contactability) ---- */
function zoneMatches(c, z) {
  if (z.type === "radius") return haversineMiles(c.lng, c.lat, z.anchorLng, z.anchorLat) <= z.radiusMi;
  if (z.type === "corridor") return pointToRouteMiles(c.lng, c.lat, z.route) <= z.bufferMi;
  return false;
}
function distanceToSearch(c, zones) {
  if (!zones || !zones.length) return null;
  let min = Infinity;
  zones.forEach(z => {
    const d = z.type === "radius" ? haversineMiles(c.lng, c.lat, z.anchorLng, z.anchorLat)
                                  : pointToRouteMiles(c.lng, c.lat, z.route);
    if (d < min) min = d;
  });
  return min === Infinity ? null : min;
}
function carrierMatchesSearch(c, s) {
  // geo — UNION of lanes (F21)
  if (s.zones && s.zones.length) { if (!s.zones.some(z => zoneMatches(c, z))) return false; }
  // cargo — flags OR other-include, minus other-exclude (F14)
  if (s.cargo) {
    const flags = s.cargo.flags || [];
    const oth = s.cargo.other || {};
    const inc = (oth.enabled && oth.include) ? oth.include : [];
    const exc = (oth.enabled && oth.exclude) ? oth.exclude : [];
    if (c.cargo_other_norm && exc.includes(c.cargo_other_norm)) return false;
    const flagHit = flags.some(f => c.cargoFlags.includes(f));
    const otherHit = c.cargo_other_norm && inc.includes(c.cargo_other_norm);
    if ((flags.length || inc.length) && !(flagHit || otherHit)) return false;
  }
  if (s.forHire && c.classdef !== "Authorized For Hire") return false;
  if (s.activeOnly && !c.active) return false;
  if (s.authorizedOnly && c.ins.authority_status !== "active") return false;
  if (s.interstateOnly && c.operation !== "Interstate") return false;
  if (s.sizeMin != null && c.power_units < s.sizeMin) return false;
  if (s.sizeMax != null && c.power_units > s.sizeMax) return false;
  if (s.hasPhone && !(c.phone || c.cell)) return false;         // F16/G4
  if (s.hasEmail && !c.email) return false;                     // F16/G4
  if (s.insuranceMin && !s.keepBelow && c.ins.bipd_on_file < s.insuranceMin) return false;
  return true;
}
function searchMatches(s) { return carriers.filter(c => carrierMatchesSearch(c, s)); }

/* ---- lane helpers ---- */
function radiusLane(id, city, mi, material) {
  const c0 = cityOf(city);
  return { id, type:"radius", label:material, anchor: city + ", TX", anchorLng:c0.lng, anchorLat:c0.lat, radiusMi:mi, anchorKind:"city" };
}
function corridorLane(id, from, to, mi, material) {
  const a = cityOf(from), b = cityOf(to);
  const midLng = (a.lng + b.lng)/2 + rnd(-0.15,0.15), midLat = (a.lat + b.lat)/2;
  return { id, type:"corridor", label:material, origin: from + ", TX", dest: to + ", TX",
           originLng:a.lng, originLat:a.lat, destLng:b.lng, destLat:b.lat,
           route:[{lng:a.lng,lat:a.lat},{lng:midLng,lat:midLat},{lng:b.lng,lat:b.lat}], bufferMi:mi };
}

/* ---- batches: name + customer + job + N lanes (G9/F20/F21) ---- */
const SG_FLAGS = ["Commodities Dry Bulk","Construction","Building Materials"];
const batchDefs = [
  { id:"b_belt", name:"Belt Construction Recruitment", customer:"Belt Contractors LLC", job:"SH-45 belt widening",
    created_by:"u_manager", snapshot_at: NOW_MS - 9*DAY, last_refreshed: NOW_MS - 2*DAY,
    zones:[ radiusLane("z1","Austin",55,"Fill sand & base") ],
    search:{ cargo:{ flags:SG_FLAGS, other:{enabled:true,include:SG_OTHER_VALUES,exclude:[]} },
             forHire:true, activeOnly:true, insuranceMin:500000, keepBelow:true } },
  { id:"b_waco", name:"Waco Aggregate Job — Multi-Lane", customer:"McLennan Ready Mix", job:"Waco plant supply",
    created_by:"u_manager", snapshot_at: NOW_MS - 4*DAY, last_refreshed: NOW_MS - 4*DAY,
    zones:[ corridorLane("z1","Austin","Waco",35,"Concrete sand — Austin pit"),
            corridorLane("z2","Dallas","Waco",35,"Crushed limestone — Dallas quarry") ],
    search:{ cargo:{ flags:SG_FLAGS, other:{enabled:true,include:SG_OTHER_VALUES,exclude:[]} },
             forHire:true, activeOnly:true } },
  { id:"b_permian", name:"Permian Basin Aggregates", customer:"Permian Frac Co", job:"Frac sand haul",
    created_by:"u_edit2", snapshot_at: NOW_MS - 14*DAY, last_refreshed: NOW_MS - 1*DAY,
    zones:[ radiusLane("z1","Midland",80,"Frac sand") ],
    search:{ cargo:{ flags:SG_FLAGS, other:{enabled:true,include:SG_OTHER_VALUES,exclude:[]} }, activeOnly:true } },
  { id:"b_dfw", name:"DFW Metroplex · $1MM+", customer:"Metro Concrete", job:"DFW commercial pours",
    created_by:"u_manager", snapshot_at: NOW_MS - 20*DAY, last_refreshed: NOW_MS - 7*DAY,
    zones:[ radiusLane("z1","Dallas",60,"Aggregate") ],
    search:{ cargo:{ flags:SG_FLAGS, other:{enabled:true,include:SG_OTHER_VALUES,exclude:[]} },
             insuranceMin:1000000, keepBelow:false, activeOnly:true } }
];

const STATUS_POOL = ["new","new","new","new","attempted","attempted","contacted","contacted","interested","not_a_fit"];
const batches = [];
const batchCarriers = [];   // {id, batch_id, dot, status, status_by, status_at, added_at, via_refresh, promoted_at}
const callLogs = [];        // {id, dot, batch_id, user_id, at, channel, disposition, notes, next_steps, callback_at}
const activity = [];        // {id, batch_id, type, actor_id, at, payload, body}
let bcSeq = 0, clSeq = 0, actSeq = 0;

const DISPO = {
  attempted: ["no_answer","voicemail","no_answer"],
  contacted: ["connected","callback","connected"],
  interested:["interested","connected","callback"],
  not_a_fit: ["not_interested","wrong_number"]
};
const NOTE = {
  no_answer:"No answer, no VM set up.", voicemail:"Left voicemail w/ callback #.",
  connected:"Reached dispatcher, walked through the job rates.",
  callback:"Owner driving — asked to call back after 5pm.",
  interested:"Interested. Wants the rate sheet emailed + a load count.",
  not_interested:"Full up on committed freight this quarter.",
  wrong_number:"Number disconnected — needs a better contact.",
  sent:"Texted job details + our number.", replied:"Texted back, wants a call.",
  no_response:"No reply yet."
};
const NEXT = { no_answer:"Retry tomorrow AM.", voicemail:"Follow up in 2 days.",
  connected:"Send rate sheet.", callback:"Call back after 5pm Thu.",
  interested:"Send packet, then qualify insurance.", not_interested:"Re-touch next quarter.",
  wrong_number:"Skip-trace a new number.", sent:"Follow up if no reply in 2 days.", replied:"Call this afternoon.", no_response:"Try a call." };
const CHAN_OF = { sent:"text", replied:"text", no_response:"text" };

function logActivity(batchId, type, actorId, at, payload, body) {
  activity.push({ id: "a_" + (actSeq++), batch_id: batchId, type, actor_id: actorId, at, payload: payload || {}, body: body || null });
}

batchDefs.forEach((bd, bi) => {
  const matches = searchMatches({ zones: bd.zones, cargo: bd.search.cargo, forHire: bd.search.forHire,
    activeOnly: bd.search.activeOnly, insuranceMin: bd.search.insuranceMin, keepBelow: bd.search.keepBelow });
  const cap = [70, 52, 55, 44][bi] || 50;
  const members = matches.slice(0, cap);
  batches.push({
    id: bd.id, name: bd.name, customer: bd.customer, job: bd.job, created_by: bd.created_by,
    snapshot_at: bd.snapshot_at, last_refreshed: bd.last_refreshed,
    zones: bd.zones, search: bd.search, snapshot_count: members.length,
    new_since: bi === 2 ? 6 : (bi === 0 ? 3 : (bi === 1 ? 4 : 0))
  });
  logActivity(bd.id, "batch_created", bd.created_by, bd.snapshot_at, { name: bd.name });
  logActivity(bd.id, "members_added", bd.created_by, bd.snapshot_at, { count: members.length });
  members.forEach((c, idx) => {
    let status = STATUS_POOL[Math.floor(rng() * STATUS_POOL.length)];
    if (bi === 0 && idx < 22) status = pick(["attempted","contacted","interested","contacted","not_a_fit"]);
    const worker = pick(WORKERS);
    const statusAt = NOW_MS - rndInt(1, 200) * HOUR;
    const promoted = (status === "interested" && chance(0.22)) ? statusAt : null;
    batchCarriers.push({
      id: "bc_" + (bcSeq++), batch_id: bd.id, dot: c.dot, status,
      status_by: status === "new" ? null : worker, status_at: status === "new" ? bd.snapshot_at : statusAt,
      added_at: bd.snapshot_at, via_refresh: false, promoted_at: promoted
    });
    if (status !== "new" && DISPO[status]) {
      const n = status === "interested" ? rndInt(2, 3) : rndInt(1, 2);
      for (let k = 0; k < n; k++) {
        const disp = pick(DISPO[status]);
        callLogs.push({ id: "cl_" + (clSeq++), dot: c.dot, batch_id: bd.id, user_id: worker,
          at: statusAt - k * rndInt(6, 60) * HOUR, channel: CHAN_OF[disp] || "call", disposition: disp,
          notes: NOTE[disp], next_steps: NEXT[disp], callback_at: disp === "callback" ? NOW_MS + rndInt(4, 40) * HOUR : null });
      }
      logActivity(bd.id, "status_change", worker, statusAt, { dot: c.dot, to: status });
    }
    if (promoted) logActivity(bd.id, "promoted", worker, promoted, { dot: c.dot });
  });
});

// Inspection detail on a few worked carriers.
batchCarriers.filter(bc => bc.batch_id === "b_belt").slice(0, 6)
  .forEach(bc => seedInspections(carrierByDot[bc.dot], rndInt(3, 6)));

// Cross-batch unified-timeline invariant + a manual comment + a text-channel log.
(function extras() {
  const beltDots = new Set(batchCarriers.filter(b => b.batch_id === "b_belt").map(b => b.dot));
  const shared = batchCarriers.find(b => b.batch_id === "b_waco" && beltDots.has(b.dot));
  if (shared) {
    callLogs.push({ id:"cl_"+(clSeq++), dot: shared.dot, batch_id:"b_waco", user_id:"u_edit1",
      at: NOW_MS - 30*HOUR, channel:"email", disposition:"replied",
      notes:"Emailed both job sheets — same owner, wants Waco loads too.", next_steps:"Coordinate both jobs.", callback_at:null });
  }
  logActivity("b_belt", "comment", "u_manager", NOW_MS - 3*HOUR, {}, "Focusing calls on the $1MM+ carriers first this week — TxDOT wants proof of insurance.");
  logActivity("b_belt", "comment", "u_edit1", NOW_MS - 26*HOUR, {}, "Left 6 voicemails this morning, 2 callbacks pending after 5pm.");
  logActivity("b_waco", "comment", "u_manager", NOW_MS - 2*DAY, {}, "Two lanes here — Austin sand + Dallas limestone. Work them as one list.");
})();

// Refresh-candidate invariant: a matching non-member per batch exists because members are capped.
const DB = { carriers, carrierByDot, users, userById, batches, batchCarriers, callLogs, activity, cargoOtherValues, CARGO_FLAGS };
