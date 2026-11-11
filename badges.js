// ─────────────────────────────────────────────────────────────────────────────
// badges.js — runtime-layered student "collage" for Kreativa Kartan
//
// Draws, around each student's PLAIN avatar (students/<name>.png):
//   • a ring of round role badges  (from finished.roles, in earning order)
//   • a fan of flags               (one flag per 3 finished projects)
//   • a pile of gold plates        (one per 10 screenshots, from a column in the Dashboard sheet)
//
// LOAD ORDER: add  <script src="badges.js"></script>  right before </body>,
// i.e. AFTER the main script. The functions below deliberately re-declare
// (and therefore replace) these functions from index.html:
//   computeTargetPositions, placeStudentIcons, glideStudent, fadeOutStudent,
//   listenToFirebase, loadStudentPositions
// Once you're happy, you can delete the old versions from index.html.
// ─────────────────────────────────────────────────────────────────────────────

const BADGES_DIR   = 'badges/';        // badges/flag.png, badges/<role-id>.png
const FB_STUDENTS_URL = 'https://laroplanen-help-default-rtdb.europe-west1.firebasedatabase.app/students.json';
const SVG_NS       = 'http://www.w3.org/2000/svg';

// ── Tuning knobs (all sizes are multiples of the avatar size S) ──────────────
const FLAG_EVERY    = 3;      // one flag per N finished projects
const FLAG_FAN_MAX  = 8;      // flags per fan; extra flags start a 2nd, smaller fan
const FLAG_SIZE     = 0.55;   // flag box (square) size
const FLAG_BASE_X   = 0.20;   // pole base, relative to avatar centre (hidden behind the avatar)
const FLAG_BASE_Y   = -0.08;
const FLAG_ANGLE0   = 8;      // degrees (clockwise), first flag
const FLAG_ANGLE_DT = 7;      // degrees added per extra flag
const ROLE_BADGE    = 0.34;   // role badge diameter
const ROLE_RING_R0  = 0.52;   // radius of first role ring (badges almost touch the avatar)
const ROLE_RING_DR  = 0.31;   // distance between role rings
const ROLE_Y_STRETCH = 1.22;  // rings are ellipses: avatars are portraits, taller than wide
// Role badges fill clockwise (0° = right, 90° = bottom, 270° = top), leaving the
// top-right free for flags. A student with awards also loses the bottom, where the
// award row sits.
const ROLE_SECTORS_FULL      = [[10, 270]];
const ROLE_SECTORS_NO_BOTTOM = [[10, 45], [135, 270]];

// Gold plates (screenshots): a pile at the lower right that grows upwards.
// Column in the published Dashboard sheet: "Guldplåtar" (= number of plates), or
// "Screenshots" / "Skärmdumpar" (= raw count, every SCREENSHOT_EVERY gives one plate).
const SCREENSHOT_EVERY  = 10;
const PLATE_SIZE        = 0.46;   // plate box (square; art fitted inside without stretching)
const PLATE_STEP        = 0.085;  // each plate sits this much higher than the one below
const PLATE_PILE_MAX    = 14;     // plates drawn; more than that gives a "x N" label
const PLATE_X           = 0.52;   // pile centre, relative to avatar centre (the art has transparent padding: its visible edge ends up ~0.1 closer)
const PLATE_Y           = 0.40;   // centre of the lowest plate
const PLATE_REFRESH_MS  = 5 * 60 * 1000;
const ROLE_SECTORS_NO_PILE        = [[60, 270]];
const ROLE_SECTORS_NO_BOTTOM_PILE = [[135, 270]];

// Special awards: a row under the name label, centred, wrapping to more rows.
const SPECIAL_SIZE    = 0.25;  // award box (square; art is fitted inside without stretching)
const SPECIAL_GAP     = 0.025;
const SPECIAL_PER_ROW = 3;
const SPECIAL_Y0      = 0.47;  // top of the first row (the name label ends at about 0.5)

// Google Sheet tab "Priser": columns badge | label | image
const PRISER_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ8t6cBm7poXfXN9FBkzxf_paP7j_6_eggDs_pkuwqtFRHESoxk7kUcrn6hG9VaD0PaJla4KGLfIJbO/pub?gid=1392544476&single=true&output=csv';
const AWARD_WORKER   = 'https://aged-math-1ef5.jimbernstrom.workers.dev';


// ─── Awards catalogue (Google Sheet tab "Priser") ────────────────────────────
// The award's name in column "badge" is also its id, stored on students as
// students/{key}/badges/{name} = how many times it was given.

let awardCatalogue = { byId: new Map(), list: [] };
const awardOrder = id => awardCatalogue.byId.get(id)?.order ?? 1e6;
const SAFE_AWARD_ID = /^[^.$#\[\]\/]{1,80}$/;     // Firebase keys may not contain . $ # [ ] /

// Small CSV reader that understands quoted cells (commas and line breaks inside quotes).
function parseCsvRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function loadAwardCatalogue() {
  try {
    const res = await fetch(PRISER_CSV_URL + '&t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = parseCsvRows((await res.text()).replace(/^\uFEFF/, ''))
      .filter(r => r.some(c => c.trim()));
    if (!rows.length) throw new Error('empty tab');

    // Find columns by header name, falling back to the order badge | label | image
    const header = rows[0].map(c => c.trim().toLowerCase());
    const col = (names, dflt) => { const i = header.findIndex(h => names.includes(h)); return i >= 0 ? i : dflt; };
    const iB = col(['badge', 'namn', 'pris', 'id'], 0);
    const iL = col(['label', 'beskrivning', 'text'], 1);
    const iI = col(['image', 'bild', 'img'], 2);

    const byId = new Map(), list = [];
    rows.slice(1).forEach(r => {
      const id = (r[iB] || '').trim();
      if (!id || byId.has(id)) return;
      if (!SAFE_AWARD_ID.test(id)) { console.warn('Priser: skipping award with a name Firebase cannot store:', id); return; }
      const entry = { id, label: (r[iL] || '').trim(), image: (r[iI] || '').trim(), order: list.length };
      byId.set(id, entry); list.push(entry);
    });
    awardCatalogue = { byId, list };
  } catch (e) {
    console.warn('Could not load the Priser tab:', e.message);   // awards then show as gold letter circles
  }
  return awardCatalogue;
}


// ─── Gold plates: counts from the Dashboard sheet ────────────────────────────

let plateCounts = {};   // nameKey -> number of plates

function parsePlateCounts(csv) {
  const rows = parseCsvRows(csv.replace(/^\uFEFF/, ''));
  if (!rows.length) return {};
  const head = rows[0].map(h => h.trim().toLowerCase());
  let col = head.findIndex(h => /guld|plåt|plat/.test(h)), raw = false;
  if (col < 0) { col = head.findIndex(h => /screenshot|skärmdump|skarmdump/.test(h)); raw = col >= 0; }
  if (col < 0) return {};
  const out = {};
  rows.slice(1).forEach(r => {
    const name = (r[0] || '').trim();
    if (!name) return;
    const n = Number(String(r[col] ?? '').trim().replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return;
    const plates = Math.min(999, Math.floor(raw ? n / SCREENSHOT_EVERY : n));
    if (plates > 0) out[nameToKey(name)] = plates;
  });
  return out;
}

// Re-reads the sheet; returns true if any student's plate count changed.
async function reloadPlateCounts() {
  try {
    const res = await fetch(SHEET_CSV_URL + '&t=' + Date.now());
    if (!res.ok) return false;
    const next = parsePlateCounts(await res.text());
    const changed = JSON.stringify(next) !== JSON.stringify(plateCounts);
    plateCounts = next;
    return changed;
  } catch (e) { return false; }
}


// ─── Data → visuals ──────────────────────────────────────────────────────────

// Everything visual is derived from data already in students.json.
function studentVisual(studentData, key) {
  const d = studentData || {};
  const roles    = d.finished?.roles    || [];
  const projects = d.finished?.projects || [];
  // Awards are stored as { "<award name>": count } on the student
  const specials = Object.entries(d.badges || {})
    .map(([id, n]) => ({ id, count: Math.floor(Number(n)) || 0 }))
    .filter(x => x.count > 0)
    .sort((a, b) => awardOrder(a.id) - awardOrder(b.id) || a.id.localeCompare(b.id, 'sv'));
  return { roles, flags: Math.floor(projects.length / FLAG_EVERY), specials, plates: plateCounts[key] || 0 };
}

// Cheap "has anything changed?" signature so we only rebuild when needed.
function visualSig(v) {
  return v.flags + '|' + (v.plates || 0) + '|' + v.roles.join(',') + '|' + v.specials.map(x => x.id + ':' + x.count).join(',');
}

function buildAssignments(sheetRows, fbData) {
  return sheetRows
    .map(row => {
      const sd = fbData[nameToKey(row.name)] || {};
      return sd.currentNode
        ? { name: row.name, nodeId: sd.currentNode, visual: studentVisual(sd, nameToKey(row.name)) }
        : null;
    })
    .filter(Boolean);
}


// ─── Layout ──────────────────────────────────────────────────────────────────

// n angles (radians) spread evenly over the allowed sectors (degrees), ends included.
function anglesOverSectors(sectors, n) {
  const lens  = sectors.map(([a, b]) => b - a);
  const total = lens.reduce((x, y) => x + y, 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    let d = n > 1 ? (i / (n - 1)) * total : 0;
    let k = 0;
    while (k < sectors.length - 1 && d > lens[k]) { d -= lens[k]; k++; }
    out.push((sectors[k][0] + d) * Math.PI / 180);
  }
  return out;
}

// Positions (relative to avatar centre) for n role badges.
function roleSlots(count, S, reserveBottom, reservePile) {
  const sectors = reservePile
    ? (reserveBottom ? ROLE_SECTORS_NO_BOTTOM_PILE : ROLE_SECTORS_NO_PILE)
    : (reserveBottom ? ROLE_SECTORS_NO_BOTTOM : ROLE_SECTORS_FULL);
  const arcLen  = sectors.reduce((x, [a, b]) => x + (b - a), 0) * Math.PI / 180;
  const slots = [];
  const b = ROLE_BADGE * S;
  for (let ring = 0; slots.length < count; ring++) {
    const r    = (ROLE_RING_R0 + ring * ROLE_RING_DR) * S;
    const avgR = r * (1 + ROLE_Y_STRETCH) / 2;
    const n    = Math.max(1, Math.floor(arcLen * avgR / (b * 1.1)) + 1);
    const take = Math.min(n, count - slots.length);
    const angs = anglesOverSectors(sectors, n);
    for (let i = 0; i < take; i++) {
      slots.push({ x: r * Math.cos(angs[i]), y: r * ROLE_Y_STRETCH * Math.sin(angs[i]), ring });
    }
  }
  return slots;
}

// Award row: centred rows under the name label. Returns { x, y, size } per award (centres).
function specialSlots(count, S) {
  const size = SPECIAL_SIZE * S, gap = SPECIAL_GAP * S;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / SPECIAL_PER_ROW);
    const inRow = Math.min(SPECIAL_PER_ROW, count - row * SPECIAL_PER_ROW);
    const col = i % SPECIAL_PER_ROW;
    slots.push({
      x: (col - (inRow - 1) / 2) * (size + gap),
      y: SPECIAL_Y0 * S + size / 2 + row * (size + gap),
      size,
    });
  }
  return slots;
}

// Pole base, rotation and scale for each flag. Newest flag = last = drawn on top.
function flagSlots(count, S) {
  const slots = [];
  for (let i = 0; i < count; i++) {
    const layer = Math.floor(i / FLAG_FAN_MAX);
    const pos   = i % FLAG_FAN_MAX;
    slots.push({
      x: (FLAG_BASE_X + layer * 0.08) * S,
      y: (FLAG_BASE_Y - layer * 0.08) * S,
      angle: FLAG_ANGLE0 + pos * FLAG_ANGLE_DT + layer * 3,
      scale: Math.pow(0.8, layer),
    });
  }
  return slots;
}

// Centres of the plates in a pile (relative to the avatar centre), lowest first.
// A tall pile gets a smaller step so it never grows taller than about 1.2 avatars.
function plateSlots(count, S) {
  const n = Math.min(count, PLATE_PILE_MAX);
  const step = Math.min(PLATE_STEP, 0.7 / Math.max(1, n - 1)) * S;
  const slots = [];
  for (let i = 0; i < n; i++) {
    slots.push({ x: PLATE_X * S + (i % 2 ? 0.018 : -0.012) * S * (1 + (i % 3) * 0.4), y: PLATE_Y * S - i * step, size: PLATE_SIZE * S });
  }
  return slots;
}

// Radius of a circle that contains avatar + role rings + flags.
// Used to space students around a node so collages don't overlap.
function collageRadius(S, v) {
  let r = S / 2;
  if (v.roles.length) {
    const slots = roleSlots(v.roles.length, S, v.specials.length > 0, v.plates > 0);
    const rings = slots[slots.length - 1].ring + 1;
    r = Math.max(r, (ROLE_RING_R0 + (rings - 1) * ROLE_RING_DR) * S * ROLE_Y_STRETCH + ROLE_BADGE * S / 2);
  }
  if (v.flags) {
    const layers = Math.ceil(v.flags / FLAG_FAN_MAX);
    r = Math.max(r, (Math.hypot(FLAG_BASE_X, FLAG_BASE_Y) + FLAG_SIZE * 0.95 + 0.11 * (layers - 1)) * S);
  }
  if (v.plates) {
    const sl = plateSlots(v.plates, S), top = sl[sl.length - 1];
    const right = (PLATE_X + PLATE_SIZE / 2 + 0.03) * S;
    r = Math.max(r, Math.hypot(right, Math.max(Math.abs(top.y - top.size / 2), PLATE_Y * S + top.size / 2)));
  }
  if (v.specials.length) {
    const rows   = Math.ceil(v.specials.length / SPECIAL_PER_ROW);
    const bottom = (SPECIAL_Y0 + rows * (SPECIAL_SIZE + SPECIAL_GAP)) * S;
    const half   = (Math.min(v.specials.length, SPECIAL_PER_ROW) * (SPECIAL_SIZE + SPECIAL_GAP) / 2) * S;
    r = Math.max(r, Math.hypot(half, bottom));
  }
  return r;
}

// Target { cx, cy, iconSize, ... } for every student, keyed by lower-case name.
function computeTargetPositions(svg, assignments) {
  const targets = {};
  const byNode  = {};

  assignments.forEach(a => {
    const center = getNodeCenter(svg, a.nodeId);
    if (!center) return;
    if (!byNode[a.nodeId]) byNode[a.nodeId] = { center, students: [] };
    byNode[a.nodeId].students.push(a);
  });

  Object.entries(byNode).forEach(([nodeId, { center, students }]) => {
    const count    = students.length;
    const iconSize = Math.max(ICON_SIZE_MIN, ICON_SIZE - Math.max(0, count - 3) * 3);

    // Space students by their whole collage, not just the avatar.
    const fps    = students.map(a => collageRadius(iconSize, a.visual));
    const maxFp  = Math.max(...fps);
    const minCirc = fps.reduce((sum, fp) => sum + 2 * fp + ICON_SPACING, 0);
    const ringRadius = Math.max(
      RADIAL_OFFSET + (maxFp - iconSize / 2) * 0.6,   // push out a bit if collages are big
      minCirc / (2 * Math.PI)
    );
    const angleStep = (2 * Math.PI) / count;

    students.forEach((a, i) => {
      const angle = RADIAL_START + i * angleStep;
      targets[a.name.trim().toLowerCase()] = {
        name: a.name,
        cx: center.x + ringRadius * Math.cos(angle),
        cy: center.y + ringRadius * Math.sin(angle),
        iconSize,
        nodeId,
        visual: a.visual,
        sig: visualSig(a.visual),
        footprint: fps[i],
      };
    });
  });

  return targets;
}


// ─── Building one student's SVG group ────────────────────────────────────────

// The map has several copies of some roles (role-photoshop-2, role-photoshop-2-2, ...).
// They are the same role, so they share the base art. Same rule nodeLabel() uses.
const roleBaseId = id => id.replace(/(-\d+)-\d+$/, '$1');
function roleArtUrls(id) {
  const base = roleBaseId(id);
  return base === id ? [`${BADGES_DIR}${id}.png`] : [`${BADGES_DIR}${id}.png`, `${BADGES_DIR}${base}.png`];
}

function makeRoleBadge(roleId, x, y, d) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'role-badge');
  g.setAttribute('data-role', roleId);

  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = nodeLabel(roleId);
  g.appendChild(title);

  const img = document.createElementNS(SVG_NS, 'image');
  const art = roleArtUrls(roleId);
  let artTry = 0;
  img.setAttribute('href', art[0]);
  img.setAttribute('x', x - d / 2);
  img.setAttribute('y', y - d / 2);
  img.setAttribute('width', d);
  img.setAttribute('height', d);
  img.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Fallback while the art doesn't exist yet: the base role's art, then a green circle with the initial.
  img.addEventListener('error', () => {
    if (++artTry < art.length) { img.setAttribute('href', art[artTry]); return; }
    img.remove();
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', d / 2);
    c.setAttribute('fill', '#2e8b57');
    c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', d * 0.06);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('font-size', d * 0.55);
    t.setAttribute('font-family', "'Century Gothic', CenturyGothic, sans-serif");
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', '#fff');
    t.setAttribute('pointer-events', 'none');
    t.textContent = nodeLabel(roleId).charAt(0);
    g.appendChild(c); g.appendChild(t);
  });

  g.appendChild(img);
  return g;
}

// One gold plate. Art: badges/screenshot.png; until it exists, a drawn gold plate.
function makePlate(slot) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'student-plate');
  const img = document.createElementNS(SVG_NS, 'image');
  img.setAttribute('href', `${BADGES_DIR}screenshot.png`);
  img.setAttribute('x', slot.x - slot.size / 2);
  img.setAttribute('y', slot.y - slot.size / 2);
  img.setAttribute('width', slot.size);
  img.setAttribute('height', slot.size);
  img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  img.addEventListener('error', () => {
    img.remove();
    const rx = slot.size * 0.24, ry = slot.size * 0.09, rim = slot.size * 0.04;   // about the size of the visible plate in the real art
    const mk = (tag, attrs) => { const e = document.createElementNS(SVG_NS, tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); return e; };
    g.appendChild(mk('ellipse', { cx: slot.x, cy: slot.y + rim, rx, ry, fill: '#a87400' }));                               // the plate's edge
    g.appendChild(mk('ellipse', { cx: slot.x, cy: slot.y, rx, ry, fill: '#f5b800', stroke: '#fff3b0', 'stroke-width': slot.size * 0.02 }));
    g.appendChild(mk('ellipse', { cx: slot.x, cy: slot.y, rx: rx * 0.62, ry: ry * 0.62, fill: 'none', stroke: '#d99a00', 'stroke-width': slot.size * 0.025 }));
  });
  g.appendChild(img);
  return g;
}

function makePlatePile(count, S) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'plate-pile');
  g.setAttribute('data-plates', count);
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = `${count} guldplåt${count === 1 ? '' : 'ar'} (${count * SCREENSHOT_EVERY} screenshots)`;
  g.appendChild(title);
  const slots = plateSlots(count, S);
  slots.forEach(sl => g.appendChild(makePlate(sl)));
  if (count > slots.length) {
    const top = slots[slots.length - 1];
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', top.x + top.size * 0.5); t.setAttribute('y', top.y - top.size * 0.2);
    t.setAttribute('font-size', S * 0.22); t.setAttribute('font-weight', '800');
    t.setAttribute('font-family', "'Century Gothic', CenturyGothic, sans-serif");
    t.setAttribute('fill', '#f5b800'); t.setAttribute('stroke', '#000'); t.setAttribute('stroke-width', S * 0.015);
    t.setAttribute('paint-order', 'stroke'); t.setAttribute('pointer-events', 'none');
    t.textContent = '×' + count;
    g.appendChild(t);
  }
  return g;
}

function makeFlag(slot, S) {
  const size = FLAG_SIZE * S * slot.scale;
  const wrap = document.createElementNS(SVG_NS, 'g');
  wrap.setAttribute('class', 'student-flag');
  // Pole base at (0,0); fan rotation is applied around it.
  wrap.setAttribute('transform', `translate(${slot.x},${slot.y}) rotate(${slot.angle})`);

  const img = document.createElementNS(SVG_NS, 'image');
  img.setAttribute('href', `${BADGES_DIR}flag.png`);
  // Draw with the box's bottom-left corner at the pole base.
  img.setAttribute('x', 0);
  img.setAttribute('y', -size);
  img.setAttribute('width', size);
  img.setAttribute('height', size);
  img.setAttribute('preserveAspectRatio', 'xMinYMax meet');

  // Fallback while flag.png doesn't exist yet: a simple pennant with the number.
  img.addEventListener('error', () => {
    img.remove();
    const pole = document.createElementNS(SVG_NS, 'line');
    pole.setAttribute('x1', 0); pole.setAttribute('y1', 0);
    pole.setAttribute('x2', 0); pole.setAttribute('y2', -size);
    pole.setAttribute('stroke', '#8a8f98'); pole.setAttribute('stroke-width', size * 0.05);
    const cloth = document.createElementNS(SVG_NS, 'polygon');
    cloth.setAttribute('points', `0,${-size} ${size * 0.85},${-size * 0.8} 0,${-size * 0.55}`);
    cloth.setAttribute('fill', '#43b581');
    cloth.setAttribute('stroke', '#fff'); cloth.setAttribute('stroke-width', size * 0.03);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', size * 0.27); t.setAttribute('y', -size * 0.76);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('font-size', size * 0.3);
    t.setAttribute('font-family', "'Century Gothic', CenturyGothic, sans-serif");
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', '#fff');
    t.setAttribute('pointer-events', 'none');
    t.textContent = String(FLAG_EVERY);
    wrap.appendChild(pole); wrap.appendChild(cloth); wrap.appendChild(t);
  });

  wrap.appendChild(img);
  return wrap;
}

function awardImageUrl(entry) {
  const img = (entry?.image || '').trim();
  if (!img) return '';
  return /^https?:\/\//i.test(img) ? img : BADGES_DIR + img;
}

function makeSpecial(award, slot) {
  const entry = awardCatalogue.byId.get(award.id);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'special-badge');
  g.setAttribute('data-award', award.id);

  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = award.id + (entry?.label ? ' – ' + entry.label : '') + (award.count > 1 ? ` (x${award.count})` : '');
  g.appendChild(title);

  const d = slot.size, x = slot.x - d / 2, y = slot.y - d / 2;
  const fallback = () => {                       // missing image / row not in the sheet
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', slot.x); c.setAttribute('cy', slot.y); c.setAttribute('r', d / 2);
    c.setAttribute('fill', '#d4a017');
    c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', d * 0.06);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', slot.x); t.setAttribute('y', slot.y);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('font-size', d * 0.55);
    t.setAttribute('font-family', "'Century Gothic', CenturyGothic, sans-serif");
    t.setAttribute('font-weight', '700'); t.setAttribute('fill', '#fff');
    t.setAttribute('pointer-events', 'none');
    t.textContent = award.id.charAt(0).toUpperCase();
    g.insertBefore(c, g.querySelector('.special-count'));
    g.insertBefore(t, g.querySelector('.special-count'));
  };

  const url = awardImageUrl(entry);
  if (url) {
    const img = document.createElementNS(SVG_NS, 'image');
    img.setAttribute('href', url);
    img.setAttribute('x', x); img.setAttribute('y', y);
    img.setAttribute('width', d); img.setAttribute('height', d);
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');   // never stretch the art
    img.addEventListener('error', () => { img.remove(); fallback(); });
    g.appendChild(img);
  } else {
    fallback();
  }

  if (award.count > 1) {                          // "x2" in the corner, like on the old collages
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'special-count');
    t.setAttribute('x', slot.x + d / 2); t.setAttribute('y', slot.y + d / 2);
    t.setAttribute('text-anchor', 'end');
    t.setAttribute('font-size', d * 0.42);
    t.setAttribute('font-family', "'Century Gothic', CenturyGothic, sans-serif");
    t.setAttribute('font-weight', '800'); t.setAttribute('fill', '#fff');
    t.setAttribute('stroke', '#111'); t.setAttribute('stroke-width', d * 0.11);
    t.setAttribute('paint-order', 'stroke'); t.setAttribute('stroke-linejoin', 'round');
    t.setAttribute('pointer-events', 'none');
    t.textContent = 'x' + award.count;
    g.appendChild(t);
  }
  return g;
}

// Who may open a student's side panel? Teachers: everyone. A student: only their own.
// (Anyone not logged in as one of those gets nothing.)
function canOpenStudentPanel(name) {
  const email = window.loggedInEmail || '';
  if (email && !email.endsWith('@edu.orebro.se')) return true;
  const own = nameToKey(window.loggedInStudentName || sessionStorage.getItem('auth_name') || '');
  return !!own && nameToKey(name || '') === own;
}

// Click on an avatar: your own (or any, for a teacher) opens the student panel;
// somebody else's avatar opens the panel of the node they are standing on, as before.
function attachStudentHandlers(svg, g, name, nodeId) {
  g.addEventListener('click', e => {
    e.stopPropagation();
    if (canOpenStudentPanel(name)) openStudentPanel(name);
    else openPanel(nodeId, svg.getElementById(nodeId));
  });
}

// Everything is positioned relative to (0,0) = avatar centre, so the whole
// collage moves with ONE transform on the group (cheap to animate).
function buildStudentGroup(svg, name, nodeId, S, v) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'student-icon-group');
  g.setAttribute('data-student', name);
  g.setAttribute('data-node', nodeId);
  g.style.cursor = 'pointer';

  // 1. role badges (behind the avatar)
  const slots = roleSlots(v.roles.length, S, v.specials.length > 0, v.plates > 0);
  v.roles.forEach((roleId, i) => {
    g.appendChild(makeRoleBadge(roleId, slots[i].x, slots[i].y, ROLE_BADGE * S));
  });

  // 2. flags (behind the avatar: the pole base is hidden, the flag sticks up; newest on top)
  flagSlots(v.flags, S).forEach(slot => g.appendChild(makeFlag(slot, S)));

  // 2b. gold plates: a pile at the lower right (in front of the flags)
  if (v.plates) g.appendChild(makePlatePile(v.plates, S));

  // 3. avatar (plain PNG, no baked-in badges)
  const avatar = document.createElementNS(SVG_NS, 'image');
  avatar.setAttribute('href', `${STUDENTS_DIR}${nameToKey(name)}.png`);
  avatar.setAttribute('x', -S / 2);
  avatar.setAttribute('y', -S / 2);
  avatar.setAttribute('width', S);
  avatar.setAttribute('height', S);
  avatar.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  g.appendChild(avatar);

  // 4. special awards: a row under the name label (in front of everything)
  const sSlots = specialSlots(v.specials.length, S);
  v.specials.forEach((aw, i) => g.appendChild(makeSpecial(aw, sSlots[i])));

  attachStudentHandlers(svg, g, name, nodeId);
  return g;
}

function makeConnector(fname) {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', 'student-connector');
  line.setAttribute('data-connector', `connector-${fname}`);
  line.setAttribute('stroke', 'rgba(255,255,255,0.2)');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-dasharray', '4 3');
  return line;
}

// Connector lines live in their own group at the bottom of the student layer.
function getLinesLayer(layer) {
  let lines = layer.querySelector('#student-lines');
  if (!lines) {
    lines = document.createElementNS(SVG_NS, 'g');
    lines.setAttribute('id', 'student-lines');
    layer.insertBefore(lines, layer.firstChild);
  }
  return lines;
}

// Case-insensitive lookup of one student's group(s) and connector(s).
function findStudentEls(layer, name) {
  const key = nameToKey(name);
  const groups = Array.from(layer.querySelectorAll('.student-icon-group'))
    .filter(el => nameToKey(el.getAttribute('data-student') || '') === key);
  const lines = Array.from(layer.querySelectorAll(`[data-connector="connector-${key}"]`));
  return { groups, lines };
}


// ─── Placement & animation ───────────────────────────────────────────────────

// Initial placement — no animation.
function placeStudentIcons(svg, assignments) {
  svg.querySelectorAll('#student-layer').forEach(el => el.remove());

  const layer = document.createElementNS(SVG_NS, 'g');
  layer.setAttribute('id', 'student-layer');
  const lines = getLinesLayer(layer);

  const targets = computeTargetPositions(svg, assignments);
  Object.values(targets).forEach(t => {
    const center = getNodeCenter(svg, t.nodeId);
    const line = makeConnector(nameToKey(t.name));
    line.setAttribute('x1', center.x); line.setAttribute('y1', center.y);
    line.setAttribute('x2', t.cx);     line.setAttribute('y2', t.cy);
    lines.appendChild(line);

    const g = buildStudentGroup(svg, t.name, t.nodeId, t.iconSize, t.visual);
    g.setAttribute('transform', `translate(${t.cx},${t.cy})`);
    layer.appendChild(g);
  });

  svg.appendChild(layer);
}

// (Re)builds a student's group and glides it from (fromCX, fromCY) to the target.
// Also used for "same place, new badges" — it just doesn't move.
function glideStudent(svg, name, fromCX, fromCY, target, nodeCenter) {
  if (activeAnimations[name]) cancelAnimationFrame(activeAnimations[name]);

  const layer = svg.getElementById('student-layer');
  if (!layer) return;

  const old = findStudentEls(layer, name);
  old.groups.forEach(el => el.remove());
  old.lines.forEach(el => el.remove());

  const line = makeConnector(nameToKey(name));
  getLinesLayer(layer).appendChild(line);

  const g = buildStudentGroup(svg, name, target.nodeId, target.iconSize, target.visual);
  layer.appendChild(g);

  const lineSrcX = nodeCenter?.x ?? target.cx;
  const lineSrcY = nodeCenter?.y ?? target.cy;
  const startTime = performance.now();

  function step(now) {
    const t    = Math.min((now - startTime) / GLIDE_DURATION, 1);
    const ease = GLIDE_EASE(t);
    const cx = fromCX + (target.cx - fromCX) * ease;
    const cy = fromCY + (target.cy - fromCY) * ease;

    g.setAttribute('transform', `translate(${cx},${cy})`);   // one attribute moves the whole collage
    line.setAttribute('x1', lineSrcX); line.setAttribute('y1', lineSrcY);
    line.setAttribute('x2', cx);       line.setAttribute('y2', cy);

    if (t < 1) activeAnimations[name] = requestAnimationFrame(step);
    else delete activeAnimations[name];
  }
  activeAnimations[name] = requestAnimationFrame(step);
}

function fadeOutStudent(svg, name) {
  if (activeAnimations[name]) cancelAnimationFrame(activeAnimations[name]);

  const layer = svg.getElementById('student-layer');
  if (!layer) return;
  const { groups, lines } = findStudentEls(layer, name);
  const els = [...groups, ...lines];
  if (!els.length) return;

  const startTime = performance.now();
  function fade(now) {
    const t = Math.min((now - startTime) / FADE_DURATION, 1);
    els.forEach(el => { el.style.opacity = 1 - t; });
    if (t < 1) activeAnimations[name] = requestAnimationFrame(fade);
    else { els.forEach(el => el.remove()); delete activeAnimations[name]; }
  }
  activeAnimations[name] = requestAnimationFrame(fade);
}


// ─── Live updates ────────────────────────────────────────────────────────────

function listenToFirebase(svg, sheetRows) {
  firebaseSheetRows = sheetRows;
  let polling = false;

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const fbRes  = await fetch(FB_STUDENTS_URL);
      const fbData = await fbRes.json() || {};
      window.updateProjectRatings?.(fbData);            // star averages on the project nodes (ratings.js)

      const newTargets = computeTargetPositions(svg, buildAssignments(sheetRows, fbData));

      // Removals
      Object.keys(currentPositions).forEach(key => {
        if (!newTargets[key]) {
          fadeOutStudent(svg, key);
          delete currentPositions[key];
        }
      });

      // Moves, additions, and badge changes (rebuild only when something differs)
      Object.entries(newTargets).forEach(([key, t]) => {
        const old     = currentPositions[key];
        const moved   = !old || Math.abs(old.cx - t.cx) > 1 || Math.abs(old.cy - t.cy) > 1;
        const changed = !old || old.sig !== t.sig || old.iconSize !== t.iconSize || old.nodeId !== t.nodeId;
        if (moved || changed) {
          glideStudent(svg, t.name, old?.cx ?? t.cx, old?.cy ?? t.cy, t, getNodeCenter(svg, t.nodeId));
          currentPositions[key] = t;
        }
      });
    } catch (e) {
      console.warn('Firebase poll failed:', e.message);
    } finally {
      polling = false;
    }
  }

  window.pollStudentsNow = pollOnce;      // called right after a teacher gives / removes an award
  setInterval(pollOnce, 10_000);
  // The sheet only changes when the teacher edits it, so a slow refresh is plenty
  window.refreshPlates = async () => { if (await reloadPlateCounts()) pollOnce(); };
  setInterval(window.refreshPlates, PLATE_REFRESH_MS);
}

async function loadStudentPositions(svg) {
  try {
    const res = await fetch(SHEET_CSV_URL + '&t=' + Date.now());
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
    const csv = await res.text();
    const sheetRows = parseCSV(csv);

    allStudentNames = parseAllStudentNames(csv);      // full roster for Hall of Fame
    initStudentDropdown(sheetRows.map(a => a.name));  // current students only

    await loadAwardCatalogue();                       // award names + pictures (Priser tab)
    plateCounts = parsePlateCounts(csv);              // gold plates (a column in the same sheet)

    const fbRes  = await fetch(FB_STUDENTS_URL);
    const fbData = await fbRes.json() || {};
    window.updateProjectRatings?.(fbData);              // star averages on the project nodes (ratings.js)

    const assignments = buildAssignments(sheetRows, fbData);
    placeStudentIcons(svg, assignments);
    currentPositions = computeTargetPositions(svg, assignments);

    listenToFirebase(svg, sheetRows);
    console.log(`Loaded ${assignments.length} student assignments from Firebase`);
  } catch (e) {
    console.warn('Could not load student positions:', e.message);
  }
}


// ─── Teacher UI: toolbar in the panel header ─────────────────────────────────
// Four compact buttons next to the student's name: Tilldela, Klar!, Ge pris, Lås upp.
// Each one that needs a choice opens a dropdown right under it.

window.teacherToolbar = true;     // tells index.html to skip its old full-width teacher buttons

const escHtml = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function awardRequest(path, body) {
  const token = sessionStorage.getItem('auth_token');
  const res = await fetch(AWARD_WORKER + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...body }),
  });
  if (!res.ok) throw new Error('Worker ' + res.status);
  return res.json();
}

// Every role on the map once. Copies of the same role are merged (same label), the
// student's already finished roles are marked, and the id we store is the base one.
function roleChoices(finishedRoles) {
  const svg = (typeof getSvg === 'function' && getSvg()) || document.querySelector('#mapCanvas svg');
  const ids = new Set();
  svg?.querySelectorAll('[id^="role-"]').forEach(el => ids.add(el.getAttribute('id')));
  const byLabel = new Map();
  ids.forEach(id => {
    const label = nodeLabel(id);
    if (!byLabel.has(label)) byLabel.set(label, { label, ids: [] });
    byLabel.get(label).ids.push(id);
  });
  const have = new Set(finishedRoles);
  return [...byLabel.values()]
    .map(g => ({ label: g.label, id: g.ids.find(i => roleBaseId(i) === i) || g.ids[0], done: g.ids.some(i => have.has(i)) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'sv', { numeric: true }));
}

// Every project and role node on the map, for "Tilldela".
function assignChoices() {
  const svg = (typeof getSvg === 'function' && getSvg()) || document.querySelector('#mapCanvas svg');
  const out = [], seen = new Set();
  svg?.querySelectorAll('[id^="project-"], [id^="role-"]').forEach(el => {
    const id = el.getAttribute('id');
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      kind: id.startsWith('role-') ? 'Roll' : 'Projekt',
      label: id.replace(/^(project-|role-)/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    });
  });
  return out.sort((a, b) => a.label.localeCompare(b.label, 'sv', { numeric: true }));
}

const awardThumb = id => {
  const url = awardImageUrl(awardCatalogue.byId.get(id));
  return url
    ? `<img src="${escHtml(url)}" alt="" style="width:28px;height:28px;object-fit:contain;flex-shrink:0;" onerror="this.style.visibility='hidden'">`
    : `<span style="width:28px;height:28px;flex-shrink:0;"></span>`;
};
const roleThumb = id => {
  const [first, second] = roleArtUrls(id);
  return `<img src="${escHtml(first)}" ${second ? `data-alt="${escHtml(second)}"` : ''} alt=""
    style="width:28px;height:28px;object-fit:contain;flex-shrink:0;"
    onerror="if(this.dataset.alt){this.src=this.dataset.alt;this.dataset.alt='';}else{this.style.visibility='hidden';}">`;
};

const TB_BTN = 'padding:7px 12px;border:none;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;';
const TB_ROW = 'display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:8px 12px;background:#fff;border:none;border-bottom:1px solid #eee;cursor:pointer;font-family:inherit;';

function closeToolbarPopovers(except) {
  document.querySelectorAll('#teacherToolbar .tb-pop').forEach(p => { if (p !== except) p.style.display = 'none'; });
}
if (!window.__toolbarCloseHooks) {
  window.__toolbarCloseHooks = true;
  document.addEventListener('mousedown', e => { if (!e.target.closest('#teacherToolbar .tb-item')) closeToolbarPopovers(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeToolbarPopovers(); });
}

// A toolbar button with a dropdown under it.
//   cfg.items(query) -> [{ id, html }]   (rows)      cfg.onOpen() optional, may be async
//   cfg.search: show a search box         cfg.onPick(id)
function toolbarDropdown(key, label, colors, cfg) {
  const wrap = document.createElement('div');
  wrap.className = 'tb-item';
  wrap.style.position = 'relative';
  wrap.innerHTML = `
    <button class="tb-btn" data-tb="${key}" style="${TB_BTN}background:${colors[0]};color:${colors[1]};">${label}</button>
    <div class="tb-pop" data-tb="${key}" style="display:none;position:absolute;top:calc(100% + 6px);left:0;width:${cfg.width}px;max-width:calc(100vw - 32px);background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.22);z-index:60;overflow:hidden;">
      ${cfg.search ? `<input class="tb-search" type="text" placeholder="${escHtml(cfg.search)}" autocomplete="off" style="width:100%;padding:9px 12px;border:none;border-bottom:1px solid #ddd;font-family:inherit;font-size:13px;color:#111;background:#f7f7f9;outline:none;box-sizing:border-box;">` : ''}
      <div class="tb-list" style="max-height:min(52vh,340px);overflow-y:auto;"></div>
    </div>`;
  const btn = wrap.querySelector('.tb-btn'), pop = wrap.querySelector('.tb-pop'), list = wrap.querySelector('.tb-list'), search = wrap.querySelector('.tb-search');

  const render = () => {
    const rows = cfg.items((search?.value || '').trim().toLowerCase());
    list.innerHTML = rows.length
      ? rows.map(r => `<button class="tb-row" data-id="${escHtml(r.id)}" style="${TB_ROW}" onmouseover="this.style.background='#f7f7f9'" onmouseout="this.style.background='#fff'">${r.html}</button>`).join('')
      : `<div style="padding:12px;font-size:12px;color:#bbb;">${escHtml(cfg.empty(search?.value))}</div>`;
  };
  const place = () => {            // keep the dropdown inside the panel
    pop.style.left = '0'; pop.style.right = 'auto';
    const pr = document.getElementById('panel').getBoundingClientRect();
    pop.style.maxWidth = Math.max(200, pr.width - 16) + 'px';
    const r = pop.getBoundingClientRect();
    if (r.right > pr.right - 8) { pop.style.left = 'auto'; pop.style.right = '0'; }
    const r2 = pop.getBoundingClientRect();
    if (r2.left < pr.left + 8) { pop.style.right = 'auto'; pop.style.left = (pr.left + 8 - wrap.getBoundingClientRect().left) + 'px'; }
  };

  btn.addEventListener('click', async () => {
    if (pop.style.display === 'block') { pop.style.display = 'none'; return; }
    closeToolbarPopovers(pop);
    if (cfg.onOpen) await cfg.onOpen();
    if (search) search.value = '';
    render();
    pop.style.display = 'block';
    place();
    search?.focus();
  });
  search?.addEventListener('input', render);
  list.addEventListener('click', async e => {
    const row = e.target.closest('.tb-row');
    if (!row) return;
    row.disabled = true;
    try { await cfg.onPick(row.dataset.id); }
    catch (err) { console.error('[toolbar]', cfg.error, err); alert(cfg.error); row.disabled = false; }
  });
  return wrap;
}

// The read-only "Priser" list in the panel body, with a × to take one away.
// readOnly: the student's own view — no remove buttons, with each award's description under its name.
function addAwardList(studentName, st, refresh, readOnly = false) {
  const body = document.getElementById('panelBody');
  const key = nameToKey(studentName);
  const mine = Object.entries(st.badges || {})
    .map(([id, n]) => ({ id, count: Math.floor(Number(n)) || 0 }))
    .filter(a => a.count > 0)
    .sort((a, b) => awardOrder(a.id) - awardOrder(b.id) || a.id.localeCompare(b.id, 'sv'));

  const sec = document.createElement('div');
  sec.id = 'awardSection';
  sec.style.cssText = readOnly ? 'margin:18px 0 20px;' : 'margin:4px 0 20px;';
  sec.innerHTML = `
    <div class="section-label">Priser</div>
    ${mine.length ? mine.map(a => `
      <div class="award-row" data-id="${escHtml(a.id)}" style="display:flex;align-items:center;gap:8px;padding:${readOnly ? 7 : 5}px 0;border-bottom:1px solid #eee;">
        ${awardThumb(a.id)}
        <span style="flex:1;min-width:0;">
          <span style="display:block;font-size:${readOnly ? 13 : 12}px;${readOnly ? 'font-weight:700;color:#111;' : 'color:#333;'}">${escHtml(a.id)}${a.count > 1 ? ` <b>x${a.count}</b>` : ''}</span>
          ${readOnly && awardCatalogue.byId.get(a.id)?.label ? `<span class="award-desc" style="display:block;font-size:11px;color:#999;margin-top:1px;">${escHtml(awardCatalogue.byId.get(a.id).label)}</span>` : ''}
        </span>
        ${readOnly ? '' : `<button class="award-remove" data-id="${escHtml(a.id)}" title="Ta bort en"
          style="background:none;border:none;color:#ccc;font-size:15px;cursor:pointer;padding:0 0 0 8px;line-height:1;"
          onmouseover="this.style.color='#e74c3c'" onmouseout="this.style.color='#ccc'">×</button>`}
      </div>`).join('')
      : '<div style="font-size:12px;color:#bbb;">Inga priser ännu</div>'}`;

  const grid = body.querySelector('div[style*="grid-template-columns"]');
  if (grid) grid.parentNode.insertBefore(sec, grid); else body.appendChild(sec);

  if (readOnly) return;
  sec.addEventListener('click', async e => {
    const remove = e.target.closest('.award-remove');
    if (!remove) return;
    remove.disabled = true;
    try {
      await awardRequest('/student/unaward', { studentKey: key, badgeId: remove.dataset.id });
      await refresh();
    } catch (err) {
      console.error('[award]', err);
      alert('Kunde inte ta bort priset. Försök igen.');
      remove.disabled = false;
    }
  });
}

// A student looking at their own panel: the awards they have, read-only.
async function addStudentUi(studentName) {
  const email = window.loggedInEmail || '';
  const body = document.getElementById('panelBody');
  if (!body || !email.endsWith('@edu.orebro.se') || !canOpenStudentPanel(studentName)) return;

  let st = {};
  try {
    const r = await fetch(FB_STUDENTS_URL.replace('students.json', `students/${encodeURIComponent(nameToKey(studentName))}.json`));
    st = await r.json() || {};
  } catch (e) {}

  if (document.getElementById('panelTitle')?.textContent !== studentName || document.getElementById('awardSection')) return;
  addAwardList(studentName, st, null, true);
}

function addTeacherToolbar(studentName, st, refresh) {
  const header = document.querySelector('#panel .panel-header');
  if (!header) return;
  const key = nameToKey(studentName);
  const currentNode = st.currentNode || null;
  const finished = (() => { const r = st.finished?.roles; return Array.isArray(r) ? r : Object.values(r || {}); })();
  const finishedProjects = (() => { const r = st.finished?.projects; return Array.isArray(r) ? r : Object.values(r || {}); })();

  const bar = document.createElement('div');
  bar.id = 'teacherToolbar';
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 16px;flex:1 1 auto;min-width:0;';

  // Tilldela — pick a project or role to assign
  bar.appendChild(toolbarDropdown('assign', 'Tilldela', ['#0a0a1a', '#fff'], {
    width: 320, search: 'Sök projekt eller roll…', error: 'Kunde inte tilldela uppgift. Försök igen.',
    items: q => assignChoices().filter(c => !q || c.label.toLowerCase().includes(q)).map(c => ({
      id: c.id,
      html: `<span style="flex:1;font-size:13px;font-weight:${c.id === currentNode ? 800 : 600};color:#111;">${escHtml(c.label)}${c.id === currentNode ? ' ✓' : ''}</span>
             <span style="font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.08em;">${c.kind}</span>`,
    })),
    empty: () => 'Inga träffar',
    onPick: async id => { await awardRequest('/student/assign', { studentKey: key, nodeId: id }); await refresh(); },
  }));

  // Klar! — only when there is something to finish (keeps the old confirm question)
  if (currentNode) {
    const done = document.createElement('button');
    done.className = 'tb-btn'; done.dataset.tb = 'done';
    done.style.cssText = TB_BTN + 'background:#2ecc71;color:#fff;';
    done.textContent = '✓ Klar!';
    done.addEventListener('click', async () => { closeToolbarPopovers(); await completeStudent(key, studentName); window.pollStudentsNow?.(); });
    bar.appendChild(done);
  }

  // Ge pris — pick an award from the Priser tab
  bar.appendChild(toolbarDropdown('award', '🏆 Ge pris', ['#f5b800', '#111'], {
    width: 360, error: 'Kunde inte spara priset. Försök igen.',
    onOpen: () => loadAwardCatalogue(),             // pick up rows added to the sheet since the page loaded
    items: () => awardCatalogue.list.map(a => ({
      id: a.id,
      html: `${awardThumb(a.id)}<span><span style="display:block;font-size:13px;font-weight:700;color:#111;">${escHtml(a.id)}</span>
             <span style="display:block;font-size:11px;color:#888;">${escHtml(a.label)}</span></span>`,
    })),
    empty: () => 'Inga priser hittades i fliken Priser.',
    onPick: async id => { await awardRequest('/student/award', { studentKey: key, badgeId: id }); await refresh(); },
  }));

  // Lås upp — give a finished project or role without assigning it first
  bar.appendChild(toolbarDropdown('unlock', '🔓 Lås upp', ['#3b82f6', '#fff'], {
    width: 340, search: 'Sök projekt eller roll…', error: 'Kunde inte låsa upp. Försök igen.',
    items: q => {
      const roles = roleChoices(finished).filter(c => !c.done).map(c => ({ id: c.id, label: c.label, kind: 'Roll' }));
      const haveProjects = new Set(finishedProjects);
      const projects = assignChoices().filter(c => c.kind === 'Projekt' && !haveProjects.has(c.id));
      return [...projects, ...roles]
        .filter(c => !q || c.label.toLowerCase().includes(q))
        .sort((a, b) => a.label.localeCompare(b.label, 'sv', { numeric: true }))
        .map(c => ({
          id: c.id,
          html: `${c.kind === 'Roll' ? roleThumb(c.id) : '<span style="width:28px;height:28px;flex-shrink:0;"></span>'}
                 <span style="flex:1;font-size:13px;font-weight:600;color:#111;">${escHtml(c.label)}</span>
                 <span style="font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.08em;">${c.kind}</span>`,
        }));
    },
    empty: q => q ? 'Inga träffar' : 'Allt är redan upplåst',
    onPick: async id => { await awardRequest('/student/unlock', { studentKey: key, nodeId: id }); await refresh(); },
  }));

  header.style.position = 'relative';
  header.style.zIndex = '30';                       // dropdowns must sit above the panel body
  header.insertBefore(bar, header.children[1]);     // between the name and the icons on the right
}

async function addTeacherUi(studentName) {
  const isTeacherUser = window.loggedInEmail && !window.loggedInEmail.endsWith('@edu.orebro.se');
  const body = document.getElementById('panelBody');
  if (!isTeacherUser || !body) return;

  const key = nameToKey(studentName);
  let st = {};
  try {
    const r = await fetch(FB_STUDENTS_URL.replace('students.json', `students/${encodeURIComponent(key)}.json`));
    st = await r.json() || {};
  } catch (e) {}

  // The panel may have moved on (another student, a node...) while we were fetching
  if (document.getElementById('panelTitle')?.textContent !== studentName || document.getElementById('studentViewMarker')) return;

  const marker = document.createElement('div');     // lets us notice when the panel stops showing a student
  marker.id = 'studentViewMarker';
  marker.style.display = 'none';
  body.insertBefore(marker, body.firstChild);

  const refresh = async () => { await openStudentPanel(studentName); window.pollStudentsNow?.(); };
  addAwardList(studentName, st, refresh);
  addRequestList(studentName, st, refresh);
  addTeacherToolbar(studentName, st, refresh);
}

// ── Completion requests ───────────────────────────────────────────────────────
// Students press a ✓ on a project/role and it lands here: students/{key}/requests/{nodeId} = time.

const requestDate = t => t ? new Date(t).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }) : '';
function requestRowHtml(id, t) {
  return `
      <div class="request-row" data-id="${escHtml(id)}" style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f4e6bd;">
        <span style="flex:1;min-width:0;">
          <span style="display:block;font-size:13px;font-weight:700;color:#111;">${escHtml(nodeLabel(id))}</span>
          <span style="display:block;font-size:10px;color:#a08a4a;text-transform:uppercase;letter-spacing:0.08em;">${id.startsWith('role-') ? 'Roll' : 'Projekt'}${t ? ' · ' + requestDate(t) : ''}</span>
        </span>
        <button class="request-approve" style="background:#2ecc71;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">✓ Godkänn</button>
        <button class="request-decline" style="background:#fff;color:#777;border:1px solid #ddd;border-radius:8px;padding:6px 12px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">✕ Avslå</button>
      </div>`;
}

// Teacher: the pending requests of one student, each with Godkänn / Avslå. Shown above "Priser".
function addRequestList(studentName, st, refresh) {
  const body = document.getElementById('panelBody');
  const key = nameToKey(studentName);
  const pending = Object.entries(st.requests || {})
    .filter(([id]) => /^(project|role)-/.test(id))
    .map(([id, t]) => ({ id, t: Number(t) || 0 }))
    .sort((a, b) => a.t - b.t);
  if (!body || !pending.length) return;

  const sec = document.createElement('div');
  sec.id = 'requestSection';
  sec.style.cssText = 'margin:4px 0 20px;padding:12px 14px;background:#fffaf0;border:1px solid #f1d58a;border-radius:10px;';
  sec.innerHTML = `
    <div class="section-label" style="margin-top:0;">Förfrågningar</div>
    ${pending.map(r => requestRowHtml(r.id, r.t)).join('')}`;

  const anchor = document.getElementById('awardSection') || body.querySelector('div[style*="grid-template-columns"]');
  if (anchor) anchor.parentNode.insertBefore(sec, anchor); else body.appendChild(sec);

  sec.addEventListener('click', async e => {
    const approve = e.target.closest('.request-approve'), decline = e.target.closest('.request-decline');
    const row = e.target.closest('.request-row');
    if (!row || !(approve || decline)) return;
    row.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await awardRequest(approve ? '/student/approve-request' : '/student/decline-request', { studentKey: key, nodeId: row.dataset.id });
      await refresh();
      window.refreshRequestCount?.();
    } catch (err) {
      console.error('[request]', err);
      alert('Kunde inte hantera förfrågan. Försök igen.');
      row.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  });
}

// Student: a small ✓ next to the folder/printer buttons on project and role panels.
//   grey ring = ask the teacher to mark it finished · amber = request sent (click to withdraw) · green = finished
const REQUEST_BTN_ID = 'requestDoneBtn';
const removeRequestBtn = () => document.getElementById(REQUEST_BTN_ID)?.remove();
const toPlainList = raw => Array.isArray(raw) ? raw : Object.values(raw || {});

async function addRequestButton(name) {
  removeRequestBtn();
  const email = window.loggedInEmail || '';
  const studentName = window.loggedInStudentName || sessionStorage.getItem('auth_name') || '';
  if (!email.endsWith('@edu.orebro.se') || !studentName || !/^(project|role)-/.test(name)) return;
  const folder = document.getElementById('panelFolderBtn');
  if (!folder) return;

  const isRole = name.startsWith('role-');
  const nodeId = isRole ? roleBaseId(name) : name;       // copies of a role count as the same role
  const label = nodeLabel(nodeId);

  const btn = document.createElement('button');
  btn.id = REQUEST_BTN_ID;
  btn.dataset.node = nodeId;
  btn.dataset.state = 'loading';
  btn.textContent = '✓';
  btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border-radius:50%;font-family:inherit;font-size:14px;font-weight:800;line-height:1;cursor:pointer;flex-shrink:0;border:1.5px solid #ddd;background:none;color:#ccc;';
  folder.parentNode.insertBefore(btn, folder);

  const paint = state => {
    btn.dataset.state = state;
    btn.disabled = state === 'done' || state === 'loading';
    const look = {
      loading: ['#ddd', 'none', '#ccc', 'default', ''],
      idle:    ['#bbb', 'none', '#aaa', 'pointer', 'Jag är klar – be läraren markera detta som klart'],
      pending: ['#f5b800', '#fff3cc', '#a07400', 'pointer', 'Förfrågan skickad – klicka för att ta tillbaka'],
      done:    ['#2ecc71', '#2ecc71', '#fff', 'default', 'Klar!'],
    }[state];
    btn.style.borderColor = look[0]; btn.style.background = look[1]; btn.style.color = look[2]; btn.style.cursor = look[3];
    btn.title = look[4];
  };
  paint('loading');

  try {
    const r = await fetch(FB_STUDENTS_URL.replace('students.json', `students/${encodeURIComponent(nameToKey(studentName))}.json`));
    const st = await r.json() || {};
    if (!btn.isConnected) return;                        // the panel moved on while we were fetching
    const have = toPlainList(isRole ? st.finished?.roles : st.finished?.projects);
    const finished = isRole ? have.some(i => roleBaseId(i) === nodeId) : have.includes(nodeId);
    paint(finished ? 'done' : (st.requests && nodeId in st.requests) ? 'pending' : 'idle');
  } catch (e) { paint('idle'); }

  btn.addEventListener('click', async () => {
    const state = btn.dataset.state;
    if (state !== 'idle' && state !== 'pending') return;
    const cancel = state === 'pending';
    if (!confirm(cancel ? `Ta tillbaka förfrågan om "${label}"?` : `Fråga din lärare om "${label}" är klar?`)) return;
    paint('loading');
    try {
      const res = await awardRequest('/student/request', { nodeId, cancel });
      paint(res.alreadyFinished ? 'done' : cancel ? 'idle' : 'pending');
    } catch (err) {
      console.error('[request]', err);
      alert('Kunde inte skicka förfrågan. Försök igen.');
      paint(state);
    }
  });
}

// Hook into the panel functions that already exist
if (typeof openPanel === 'function' && !openPanel.__withRequest) {
  const _openPanelOriginal = openPanel;
  openPanel = function (name, ...rest) {
    const p = _openPanelOriginal.call(this, name, ...rest);
    addRequestButton(name).catch(e => console.warn('Request button failed:', e));
    return p;
  };
  openPanel.__withRequest = true;
}
['openHallOfFame', 'openClassOverview', 'closePanel'].forEach(fn => {
  if (typeof window[fn] !== 'function' || window[fn].__noRequestBtn) return;
  const orig = window[fn];
  window[fn] = function (...a) { removeRequestBtn(); return orig.apply(this, a); };
  window[fn].__noRequestBtn = true;
});

// ── Teacher inbox: a "!" in the page header with all pending requests ────────────
const requestsOf = st => Object.entries(st?.requests || {})
  .filter(([id]) => /^(project|role)-/.test(id))
  .map(([id, t]) => ({ id, t: Number(t) || 0 }))
  .sort((a, b) => a.t - b.t);
const isTeacherNow = () => !!window.loggedInEmail && !window.loggedInEmail.endsWith('@edu.orebro.se');

async function fetchAllStudents() {
  const r = await fetch(FB_STUDENTS_URL);
  return (await r.json()) || {};
}

function setRequestCount(n) {
  const btn = document.getElementById('requestInboxBtn');
  if (!btn) return;
  const badge = btn.querySelector('.inbox-count');
  btn.dataset.count = String(n);
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.style.display = n ? 'flex' : 'none';
  btn.style.borderColor = n ? '#f5b800' : 'rgba(255,255,255,0.25)';
  btn.style.color = n ? '#f5b800' : 'rgba(255,255,255,0.85)';
  btn.title = n ? `${n} förfrågan${n === 1 ? '' : 'ar'} väntar` : 'Inga förfrågningar';
}

window.refreshRequestCount = async function () {
  if (!isTeacherNow() || !document.getElementById('requestInboxBtn')) return;
  try {
    const all = await fetchAllStudents();
    setRequestCount(Object.values(all).reduce((n, st) => n + requestsOf(st).length, 0));
  } catch (e) { /* offline: keep the old number */ }
};

// ── Activity feed: the latest happenings on the map, shown under the requests ──
// The Worker writes events/{pushId} = { t, s: studentKey, k: kind, id?, n? } for every
// assign / finish / new flag / award.
const EVENTS_URL = FB_STUDENTS_URL.replace('students.json', 'events.json');
const EVENTS_SHOWN = 15;     // what the list shows
const EVENTS_FETCHED = 40;   // what we ask Firebase for, so skipped/old kinds can't eat into the 15
const studentDisplayName = key => document.querySelector(`#studentSelect option[value="${key}"]`)?.textContent || key;

function eventWhen(t) {
  const d = new Date(t), now = new Date(), yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const hm = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `idag ${hm}`;
  if (d.toDateString() === yest.toDateString()) return `igår ${hm}`;
  return `${d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })} ${hm}`;
}

// What happened, in words (without the student's name), plus a small icon.
function eventText(ev) {
  const label = ev.id ? escHtml(nodeLabel(ev.id)) : '';
  const isRole = (ev.id || '').startsWith('role-');
  switch (ev.k) {
    case 'finish':  return isRole ? ['🔓', `låste upp <b>${label}</b>`] : ['✅', `blev klar med <b>${label}</b>`];
    case 'flag':    return ['🚩', `fick en till flagga${ev.n > 1 ? ` <span style="color:#aaa;">(nu ${ev.n})</span>` : ''}`];
    case 'award':   return ['🏆', `fick priset <b>${escHtml(ev.id || '')}</b>`];
    case 'assign':  return ['▶️', `började på <b>${label}</b>`];
    default:        return null;
  }
}

async function fillEventFeed() {
  const host = document.getElementById('eventFeed');
  if (!host) return;
  const head = '<div class="section-label" style="margin-top:0;">Senaste händelser</div>';
  let events;
  try {
    const res = await fetch(`${EVENTS_URL}?orderBy=%22%24key%22&limitToLast=${EVENTS_FETCHED}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    events = Object.values(await res.json() || {});
  } catch (e) {
    if (document.getElementById('eventFeed') === host) host.innerHTML = head + '<div style="font-size:12px;color:#bbb;">Kunde inte hämta händelser.</div>';
    return;
  }
  if (document.getElementById('eventFeed') !== host) return;          // the panel moved on
  const rows = events
    .filter(ev => ev && typeof ev.t === 'number' && eventText(ev))
    .sort((a, b) => b.t - a.t)                                        // newest first
    .slice(0, EVENTS_SHOWN);
  host.innerHTML = head + (rows.length ? rows.map(ev => {
    const [icon, text] = eventText(ev);
    return `<div class="event-row" style="display:flex;align-items:baseline;gap:8px;padding:7px 0;border-bottom:1px solid #eee;">
      <span style="width:20px;text-align:center;flex-shrink:0;">${icon}</span>
      <span style="flex:1;min-width:0;font-size:13px;color:#333;"><b class="event-who" data-key="${escHtml(ev.s || '')}" title="Öppna eleven" style="cursor:pointer;color:#111;">${escHtml(studentDisplayName(ev.s))}</b> ${text}</span>
      <span style="font-size:11px;color:#aaa;white-space:nowrap;">${eventWhen(ev.t)}</span>
    </div>`;
  }).join('') : '<div style="font-size:12px;color:#bbb;">Inga händelser ännu.</div>');
  host.addEventListener('click', e => {
    const who = e.target.closest('.event-who');
    if (who?.dataset.key) openStudentPanel(studentDisplayName(who.dataset.key));
  });
}

async function openRequestsPanel() {
  removeRequestBtn();
  document.getElementById('panel').classList.remove('closed');
  document.getElementById('panelTitle').textContent = 'Förfrågningar';
  document.getElementById('panelSubtitle').textContent = '';
  document.getElementById('panelFolderBtn').style.display = 'none';
  document.getElementById('printBtn').style.display = 'none';
  document.getElementById('panelStudents')?.remove();

  const body = document.getElementById('panelBody');
  body.style.padding = '20px'; body.style.overflow = ''; body.style.background = '';
  body.innerHTML = `<div class="empty-state"><div class="empty-icon">⋯</div>Laddar...</div>`;

  let all = {};
  try { all = await fetchAllStudents(); } catch (e) {
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">!</div>Kunde inte hämta förfrågningar.</div>`;
    return;
  }
  if (document.getElementById('panelTitle')?.textContent !== 'Förfrågningar') return;   // panel moved on

  const total = Object.values(all).reduce((n, st) => n + requestsOf(st).length, 0);
  setRequestCount(total);

  // Students with requests, the one waiting longest first
  const rows = Object.entries(all)
    .map(([key, st]) => ({ key, list: requestsOf(st) }))
    .filter(x => x.list.length)
    .sort((a, b) => a.list[0].t - b.list[0].t);

  const displayName = studentDisplayName;
  const requestsHtml = rows.length ? `<div id="requestInbox">${rows.map(x => `
    <div class="inbox-student" data-key="${escHtml(x.key)}" style="margin:0 0 18px;padding:12px 14px;background:#fffaf0;border:1px solid #f1d58a;border-radius:10px;">
      <div class="inbox-who" title="Öppna eleven" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:4px;">
        <img src="${escHtml(STUDENTS_DIR + x.key)}.png" alt="" onerror="this.style.visibility='hidden'" style="width:34px;height:34px;object-fit:contain;border-radius:50%;background:#fff;">
        <span style="font-size:14px;font-weight:800;color:#111;">${escHtml(displayName(x.key))}</span>
        <span style="font-size:10px;color:#a08a4a;margin-left:auto;">${x.list.length} väntar</span>
      </div>
      ${x.list.map(r => requestRowHtml(r.id, r.t)).join('')}
    </div>`).join('')}</div>`
    : `<div id="requestInbox" style="margin:0 0 22px;font-size:13px;color:#999;">✓ Inga förfrågningar just nu.</div>`;
  body.innerHTML = requestsHtml + '<div id="eventFeed"><div class="section-label" style="margin-top:0;">Senaste händelser</div><div style="font-size:12px;color:#bbb;">Laddar...</div></div>';
  fillEventFeed();

  const root = body.querySelector('#requestInbox');
  if (!rows.length) return;
  root.addEventListener('click', async e => {
    const card = e.target.closest('.inbox-student');
    if (!card) return;
    if (e.target.closest('.inbox-who')) { openStudentPanel(displayName(card.dataset.key)); return; }
    const approve = e.target.closest('.request-approve'), decline = e.target.closest('.request-decline'), row = e.target.closest('.request-row');
    if (!row || !(approve || decline)) return;
    row.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await awardRequest(approve ? '/student/approve-request' : '/student/decline-request', { studentKey: card.dataset.key, nodeId: row.dataset.id });
      window.pollStudentsNow?.();
      await openRequestsPanel();
    } catch (err) {
      console.error('[request]', err);
      alert('Kunde inte hantera förfrågan. Försök igen.');
      row.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  });
}
window.openRequestsPanel = openRequestsPanel;

// The "!" button. Login happens after the page has loaded, so a small timer adds it for teachers
// (and removes it again if a student logs in), and refreshes the count now and then.
(function requestInbox() {
  if (window.__requestInboxTimer) return;
  let ticks = 0;
  const tick = () => {
    const btn = document.getElementById('requestInboxBtn');
    if (!isTeacherNow()) { btn?.remove(); ticks = 0; return; }
    if (!btn) {
      const header = document.querySelector('header');
      if (!header) return;
      const b = document.createElement('button');
      b.id = 'requestInboxBtn';
      b.dataset.count = '0';
      b.style.cssText = 'position:relative;background:none;border:1px solid rgba(255,255,255,0.25);border-radius:6px;color:rgba(255,255,255,0.85);font-family:inherit;font-size:13px;font-weight:800;line-height:1;padding:5px 11px;cursor:pointer;flex-shrink:0;';
      b.innerHTML = '!<span class="inbox-count" style="display:none;position:absolute;top:-7px;right:-7px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#e74c3c;color:#fff;font-size:10px;font-weight:800;align-items:center;justify-content:center;"></span>';
      b.title = 'Förfrågningar';
      b.addEventListener('click', () => openRequestsPanel());
      const after = header.querySelector('button[title="Klassöversikt"]');
      if (after) after.after(b); else header.appendChild(b);
      ticks = 0;
      window.refreshRequestCount();
    } else if (++ticks % 15 === 0) window.refreshRequestCount();
  };
  window.__requestInboxTimer = setInterval(tick, 1000);
  tick();
})();

// Whenever the panel body is replaced by anything that is not a student (a node, Hall of Fame...),
// take the toolbar away again. It lives in the shared header, so nothing else would.
(function watchPanel() {
  const body = document.getElementById('panelBody');
  if (!body || window.__toolbarObserver) return;
  window.__toolbarObserver = new MutationObserver(() => {
    const bar = document.getElementById('teacherToolbar');
    if (bar && !document.getElementById('studentViewMarker')) {
      bar.remove();
      const header = document.querySelector('#panel .panel-header');
      if (header) { header.style.position = ''; header.style.zIndex = ''; }
    }
  });
  window.__toolbarObserver.observe(body, { childList: true });
})();

// Wrap the existing teacher panel so the toolbar is added after it has drawn itself.
if (typeof openStudentPanel === 'function' && !openStudentPanel.__withAwards) {
  const _openStudentPanelOriginal = openStudentPanel;
  openStudentPanel = async function (studentName) {
    if (!canOpenStudentPanel(studentName)) return;     // a student never gets another student's panel
    removeRequestBtn();
    await _openStudentPanelOriginal(studentName);
    try { await addTeacherUi(studentName); } catch (e) { console.warn('Teacher toolbar failed:', e); }
    try { await addStudentUi(studentName); } catch (e) { console.warn('Student awards failed:', e); }
  };
  openStudentPanel.__withAwards = true;
}
