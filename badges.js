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
const FLAG_BASE_X   = 0.30;   // pole base, relative to avatar centre (beside the head)
const FLAG_BASE_Y   = -0.12;
const FLAG_ANGLE0   = -12;    // degrees, first flag
const FLAG_ANGLE_DT = 7;      // degrees added per extra flag
const ROLE_BADGE    = 0.34;   // role badge diameter
const ROLE_RING_R0  = 0.52;   // radius of first role ring (badges almost touch the avatar)
const ROLE_RING_DR  = 0.31;   // distance between role rings
const ROLE_Y_STRETCH = 1.22;  // rings are ellipses: avatars are portraits, taller than wide
const ROLE_ARC_START = 10  * Math.PI / 180;   // roles fill clockwise from the right,
const ROLE_ARC_END   = 270 * Math.PI / 180;   // leaving the top-right free for flags


// ─── Data → visuals ──────────────────────────────────────────────────────────

// Everything visual is derived from data already in students.json.
function studentVisual(studentData) {
  const d = studentData || {};
  const roles    = d.finished?.roles    || [];
  const projects = d.finished?.projects || [];
  return { roles, flags: Math.floor(projects.length / FLAG_EVERY) };
}

// Cheap "has anything changed?" signature so we only rebuild when needed.
function visualSig(v) { return v.flags + '|' + v.roles.join(','); }

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

// Positions (relative to avatar centre) for n role badges.
function roleSlots(count, S) {
  const slots = [];
  const b = ROLE_BADGE * S;
  for (let ring = 0; slots.length < count; ring++) {
    const r   = (ROLE_RING_R0 + ring * ROLE_RING_DR) * S;
    const arc = (ROLE_ARC_END - ROLE_ARC_START);
    const n   = Math.max(1, Math.floor(arc * r * (1 + ROLE_Y_STRETCH) / 2 / (b * 1.1)));
    const step = n > 1 ? arc / (n - 1) : 0;
    for (let i = 0; i < n && slots.length < count; i++) {
      const a = ROLE_ARC_START + i * step;
      slots.push({ x: r * Math.cos(a), y: r * ROLE_Y_STRETCH * Math.sin(a), ring });
    }
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
    const slots = roleSlots(v.roles.length, S);
    const rings = slots[slots.length - 1].ring + 1;
    r = Math.max(r, (ROLE_RING_R0 + (rings - 1) * ROLE_RING_DR) * S * ROLE_Y_STRETCH + ROLE_BADGE * S / 2);
  }
  if (v.flags) {
    const layers = Math.ceil(v.flags / FLAG_FAN_MAX);
    r = Math.max(r, (Math.hypot(FLAG_BASE_X, FLAG_BASE_Y) + FLAG_SIZE * 0.95 + 0.11 * (layers - 1)) * S);
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
  const slots = roleSlots(v.roles.length, S);
  v.roles.forEach((roleId, i) => {
    g.appendChild(makeRoleBadge(roleId, slots[i].x, slots[i].y, ROLE_BADGE * S));
  });

  // 2. avatar (plain PNG, no baked-in badges)
  const avatar = document.createElementNS(SVG_NS, 'image');
  avatar.setAttribute('href', `${STUDENTS_DIR}${nameToKey(name)}.png`);
  avatar.setAttribute('x', -S / 2);
  avatar.setAttribute('y', -S / 2);
  avatar.setAttribute('width', S);
  avatar.setAttribute('height', S);
  avatar.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  g.appendChild(avatar);

  // 3. flags (in front; newest on top)
  flagSlots(v.flags, S).forEach(slot => g.appendChild(makeFlag(slot, S)));

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
  setInterval(async () => {
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
    }
  }, 10_000);
}

async function loadStudentPositions(svg) {
  try {
    const res = await fetch(SHEET_CSV_URL + '&t=' + Date.now());
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
    const csv = await res.text();
    const sheetRows = parseCSV(csv);

    allStudentNames = parseAllStudentNames(csv);      // full roster for Hall of Fame
    initStudentDropdown(sheetRows.map(a => a.name));  // current students only

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
