// ─────────────────────────────────────────────────────────────────────────────
// badges.js — runtime-layered student "collage" for Kreativa Kartan
//
// Draws, around each student's PLAIN avatar (students/<name>.png):
//   • a ring of round role badges  (from finished.roles, in earning order)
//   • a fan of flags               (one flag per 3 finished projects)
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


// ─── Data → visuals ──────────────────────────────────────────────────────────

// Everything visual is derived from data already in students.json.
function studentVisual(studentData) {
  const d = studentData || {};
  const roles    = d.finished?.roles    || [];
  const projects = d.finished?.projects || [];
  // Awards are stored as { "<award name>": count } on the student
  const specials = Object.entries(d.badges || {})
    .map(([id, n]) => ({ id, count: Math.floor(Number(n)) || 0 }))
    .filter(x => x.count > 0)
    .sort((a, b) => awardOrder(a.id) - awardOrder(b.id) || a.id.localeCompare(b.id, 'sv'));
  return { roles, flags: Math.floor(projects.length / FLAG_EVERY), specials };
}

// Cheap "has anything changed?" signature so we only rebuild when needed.
function visualSig(v) {
  return v.flags + '|' + v.roles.join(',') + '|' + v.specials.map(x => x.id + ':' + x.count).join(',');
}

function buildAssignments(sheetRows, fbData) {
  return sheetRows
    .map(row => {
      const sd = fbData[nameToKey(row.name)] || {};
      return sd.currentNode
        ? { name: row.name, nodeId: sd.currentNode, visual: studentVisual(sd) }
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
function roleSlots(count, S, reserveBottom) {
  const sectors = reserveBottom ? ROLE_SECTORS_NO_BOTTOM : ROLE_SECTORS_FULL;
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

// Radius of a circle that contains avatar + role rings + flags.
// Used to space students around a node so collages don't overlap.
function collageRadius(S, v) {
  let r = S / 2;
  if (v.roles.length) {
    const slots = roleSlots(v.roles.length, S, v.specials.length > 0);
    const rings = slots[slots.length - 1].ring + 1;
    r = Math.max(r, (ROLE_RING_R0 + (rings - 1) * ROLE_RING_DR) * S * ROLE_Y_STRETCH + ROLE_BADGE * S / 2);
  }
  if (v.flags) {
    const layers = Math.ceil(v.flags / FLAG_FAN_MAX);
    r = Math.max(r, (Math.hypot(FLAG_BASE_X, FLAG_BASE_Y) + FLAG_SIZE * 0.95 + 0.11 * (layers - 1)) * S);
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

function makeRoleBadge(roleId, x, y, d) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'role-badge');
  g.setAttribute('data-role', roleId);

  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = nodeLabel(roleId);
  g.appendChild(title);

  const img = document.createElementNS(SVG_NS, 'image');
  img.setAttribute('href', `${BADGES_DIR}${roleId}.png`);
  img.setAttribute('x', x - d / 2);
  img.setAttribute('y', y - d / 2);
  img.setAttribute('width', d);
  img.setAttribute('height', d);
  img.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Fallback while the art doesn't exist yet: green circle with the role's initial.
  img.addEventListener('error', () => {
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

function attachStudentHandlers(svg, g, name, nodeId) {
  g.addEventListener('click', e => {
    e.stopPropagation();
    const isTeacherUser = window.loggedInEmail && !window.loggedInEmail.endsWith('@edu.orebro.se');
    if (isTeacherUser) openStudentPanel(name);
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
  const slots = roleSlots(v.roles.length, S, v.specials.length > 0);
  v.roles.forEach((roleId, i) => {
    g.appendChild(makeRoleBadge(roleId, slots[i].x, slots[i].y, ROLE_BADGE * S));
  });

  // 2. flags (behind the avatar: the pole base is hidden, the flag sticks up; newest on top)
  flagSlots(v.flags, S).forEach(slot => g.appendChild(makeFlag(slot, S)));

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

    const fbRes  = await fetch(FB_STUDENTS_URL);
    const fbData = await fbRes.json() || {};

    const assignments = buildAssignments(sheetRows, fbData);
    placeStudentIcons(svg, assignments);
    currentPositions = computeTargetPositions(svg, assignments);

    listenToFirebase(svg, sheetRows);
    console.log(`Loaded ${assignments.length} student assignments from Firebase`);
  } catch (e) {
    console.warn('Could not load student positions:', e.message);
  }
}


// ─── Teacher UI: "Ge pris" in the student panel ──────────────────────────────

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

async function addAwardSection(studentName) {
  const isTeacherUser = window.loggedInEmail && !window.loggedInEmail.endsWith('@edu.orebro.se');
  const body = document.getElementById('panelBody');
  if (!isTeacherUser || !body || document.getElementById('awardSection')) return;

  const key = nameToKey(studentName);
  let counts = {};
  try {
    const r = await fetch(FB_STUDENTS_URL.replace('students.json', `students/${encodeURIComponent(key)}/badges.json`));
    counts = await r.json() || {};
  } catch (e) {}

  const mine = Object.entries(counts)
    .map(([id, n]) => ({ id, count: Math.floor(Number(n)) || 0 }))
    .filter(a => a.count > 0)
    .sort((a, b) => awardOrder(a.id) - awardOrder(b.id) || a.id.localeCompare(b.id, 'sv'));

  const thumb = id => {
    const url = awardImageUrl(awardCatalogue.byId.get(id));
    return url
      ? `<img src="${escHtml(url)}" alt="" style="width:28px;height:28px;object-fit:contain;flex-shrink:0;" onerror="this.style.visibility='hidden'">`
      : `<span style="width:28px;height:28px;flex-shrink:0;"></span>`;
  };

  const sec = document.createElement('div');
  sec.id = 'awardSection';
  sec.style.cssText = 'margin:4px 0 20px;';
  sec.innerHTML = `
    <div class="section-label">Priser</div>
    <button class="award-toggle" style="width:100%;padding:9px;background:#f5b800;border:none;border-radius:8px;color:#111;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;margin-bottom:8px;">🏆 Ge pris</button>
    <div class="award-picker" style="display:none;border:1px solid #ddd;border-radius:8px;max-height:260px;overflow-y:auto;margin-bottom:10px;"></div>
    <div class="award-list">
      ${mine.length ? mine.map(a => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #eee;">
          ${thumb(a.id)}
          <span style="font-size:12px;color:#333;flex:1;">${escHtml(a.id)}${a.count > 1 ? ` <b>x${a.count}</b>` : ''}</span>
          <button class="award-remove" data-id="${escHtml(a.id)}" title="Ta bort en"
            style="background:none;border:none;color:#ccc;font-size:15px;cursor:pointer;padding:0 0 0 8px;line-height:1;"
            onmouseover="this.style.color='#e74c3c'" onmouseout="this.style.color='#ccc'">×</button>
        </div>`).join('')
        : '<div style="font-size:12px;color:#bbb;">Inga priser ännu</div>'}
    </div>`;

  const grid = body.querySelector('div[style*="grid-template-columns"]');
  if (grid) grid.parentNode.insertBefore(sec, grid); else body.appendChild(sec);

  const picker = sec.querySelector('.award-picker');
  const renderPicker = () => {
    picker.innerHTML = awardCatalogue.list.length
      ? awardCatalogue.list.map(a => `
          <button class="award-pick" data-id="${escHtml(a.id)}" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:8px 10px;background:#fff;border:none;border-bottom:1px solid #eee;cursor:pointer;font-family:inherit;">
            ${thumb(a.id)}
            <span><span style="display:block;font-size:13px;font-weight:700;color:#111;">${escHtml(a.id)}</span>
            <span style="display:block;font-size:11px;color:#888;">${escHtml(a.label)}</span></span>
          </button>`).join('')
      : '<div style="padding:12px;font-size:12px;color:#bbb;">Inga priser hittades i fliken Priser.</div>';
  };

  const done = async () => {
    await openStudentPanel(studentName);          // redraw the panel (wrapped, so this section comes back)
    window.pollStudentsNow?.();                   // and update the map straight away
  };

  sec.addEventListener('click', async e => {
    const toggle = e.target.closest('.award-toggle');
    const pick   = e.target.closest('.award-pick');
    const remove = e.target.closest('.award-remove');
    try {
      if (toggle) {
        if (picker.style.display === 'none') {
          await loadAwardCatalogue();             // pick up rows added to the sheet since the page loaded
          renderPicker();
          picker.style.display = 'block';
        } else picker.style.display = 'none';
      } else if (pick) {
        pick.disabled = true;
        await awardRequest('/student/award', { studentKey: key, badgeId: pick.dataset.id });
        await done();
      } else if (remove) {
        remove.disabled = true;
        await awardRequest('/student/unaward', { studentKey: key, badgeId: remove.dataset.id });
        await done();
      }
    } catch (err) {
      console.error('[award]', err);
      alert('Kunde inte spara priset. Försök igen.');
      if (pick) pick.disabled = false;
      if (remove) remove.disabled = false;
    }
  });
}

// Wrap the existing teacher panel so the award section is added after it has drawn itself.
if (typeof openStudentPanel === 'function' && !openStudentPanel.__withAwards) {
  const _openStudentPanelOriginal = openStudentPanel;
  openStudentPanel = async function (studentName) {
    await _openStudentPanelOriginal(studentName);
    try { await addAwardSection(studentName); } catch (e) { console.warn('Award section failed:', e); }
  };
  openStudentPanel.__withAwards = true;
}
