// Draws the app icons from the one mark, so the tab, the Dock and the taskbar all wear the
// drawing in web/public/favicon.svg rather than three copies of it that drift apart.
//
//   node scripts/make-icons.mjs
//
// Writes src/MqttForge.Desktop/Resources: an .ico for the Windows executable, a .png for the
// GTK window on Linux, and an .icns for the macOS bundle. The three are checked in — this runs
// when the mark changes, not on every build.
//
// The rasteriser understands only the vocabulary the favicon uses: one rounded rect for the
// plate and two filled paths of straight-sided polygons — the rule and the F it carries — all on
// a 24-unit square. Anything else in that file is an error rather than a silent omission — an
// icon that quietly lost half its drawing is worse than a build that stopped.
//
// What is written is not the favicon's flat cut. The shapes and the colours are read from it and
// nothing else is; the body — a slab with a front edge, the crossing standing off it, the shadow
// it throws — is lighting, worked out below under `the relief`. The mark in the tab and in the
// rail stays flat, at sizes where a shadow would only be mud.
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, 'web/public/favicon.svg');
const OUT = join(ROOT, 'src/MqttForge.Desktop/Resources');

/** The drawing's own square. Everything below is in these units until it is sampled. */
const UNITS = 24;

// ---- reading the mark ----

const svg = readFileSync(SOURCE, 'utf8');

const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
// `defs` holds the clip path the browser needs to trim the drawing to the plate's corners, and
// its rect is a copy of the plate rather than a shape of its own. This rasteriser cuts the same
// corners itself, so the block is dropped before the shapes are read — left in, its rect would
// be picked up as a second ground.
const body = svg.replace(/<defs\b[\s\S]*?<\/defs>/g, '');
const tags = [...body.matchAll(/<(rect|path)\b[^>]*>/g)].map(([tag]) => tag);

/**
 * `M`, `L`, `H` and `Z` — the four the mark is written in. Returns one array of points per
 * subpath, which is a run of straight lines whether it ends up stroked or filled.
 */
function runs(d) {
  const out = [];
  let at = null;
  let run = null;

  for (const [, command, rest] of d.matchAll(/([MLHZ])\s*([-\d.\s,]*)/gi)) {
    const numbers = rest.trim().split(/[\s,]+/).filter(Boolean).map(Number);

    if (command.toUpperCase() === 'Z') {
      if (run && run.length > 2) run.push(run[0]);
      continue;
    }
    if (command.toUpperCase() === 'M') {
      at = [numbers[0], numbers[1]];
      run = [at];
      out.push(run);
      // A moveto with extra pairs draws lines, which this file never does.
      if (numbers.length > 2) throw new Error(`unsupported polyline moveto in ${d}`);
      continue;
    }
    if (!run) throw new Error(`path starts without a moveto: ${d}`);

    at = command.toUpperCase() === 'H' ? [numbers[0], at[1]] : [numbers[0], numbers[1]];
    run.push(at);
  }

  return out;
}

const shapes = tags.map((tag) => {
  if (tag.startsWith('<rect')) {
    // `rx` is the plate's corner, in the drawing's own units. Absent, the plate is a square.
    return { kind: 'ground', colour: attr(tag, 'fill'), radius: Number(attr(tag, 'rx') ?? 0) };
  }

  return { kind: 'fill', runs: runs(attr(tag, 'd')), colour: attr(tag, 'fill') };
});

const expected = ['ground', 'fill', 'fill'];
if (shapes.map((shape) => shape.kind).join() !== expected.join()) {
  throw new Error(`${SOURCE} is no longer ${expected.join(' + ')}; the rasteriser needs updating`);
}

/** The plate's corner radius, as a share of the square, so it survives any output size. */
const CORNER = shapes[0].radius / UNITS;

const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

// ---- the drawing, asked one point at a time ----

/** Crossing number, which is enough for the convex quads this mark is cut into. */
function inside(x, y, points) {
  let is = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) is = !is;
  }

  return is;
}

/** The colour at a point in the drawing's own units, or null where the ground is not laid. */
function colourAt(x, y) {
  let colour = null;

  for (const shape of shapes) {
    if (shape.kind === 'ground') colour = shape.colour;
    if (shape.kind === 'fill' && shape.runs.some((run) => inside(x, y, run))) colour = shape.colour;
  }

  return colour;
}

// ---- the relief ----

// The favicon is flat, and stays flat: a tab draws it at sixteen pixels, where a shadow is a
// smudge. The icons cut here are larger and sit among icons that have a body, so this is where
// the mark gets one — the plate becomes a slab seen from a little above and to the right, so it
// shows its face, its front edge and its right side, and the crossing stands off the face the
// same way and throws a shadow on it. Nothing below adds a shape to the drawing; it only lights
// the ones the favicon has. The light is above and a little to the left, which is where every
// desktop that draws shadows puts it: the right side is in shade, the front edge deeper in it.

/** The slab's thickness, as a share of the icon: how far down and right its back is drawn. */
const DEPTH = 0.07;
/** How far in from the face's rim the rounding-over runs, as a share of the face. */
const BEVEL = 0.045;
/** How far the crossing stands off the plate, in the drawing's own units. */
const RISE = 0.5;
/** The shadow the crossing throws: where it lands, how soft it is, how dark. In drawing units. */
const CAST = { dx: 0.3, dy: 0.5, blur: 0.55, weight: 0.5 };
/** The lit rim along the top of each raised piece, in drawing units. */
const GLINT = 0.16;

const clamp = (v) => Math.max(0, Math.min(255, v));
const scale = (c, k) => c.map((v) => clamp(v * k));
const mix = (c, to, t) => c.map((v, i) => v + (to[i] - v) * t);
const WHITE = [255, 255, 255];

/** A box blur run twice along each axis, which is near enough a Gaussian for a shadow. */
function soften(src, n, r) {
  if (r < 1) return src;
  const w = 2 * r + 1;
  const pass = (from, line, cell) => {
    const to = new Uint8Array(from.length);
    for (let a = 0; a < n; a++) {
      let sum = 0;
      for (let b = -r; b < n; b++) {
        if (b + r < n) sum += from[a * line + (b + r) * cell];
        if (b - r - 1 >= 0) sum -= from[a * line + (b - r - 1) * cell];
        if (b >= 0) to[a * line + b * cell] = sum / w;
      }
    }
    return to;
  };
  let out = src;
  for (let turn = 0; turn < 2; turn++) out = pass(pass(out, n, 1), 1, n);

  return out;
}

// ---- rasterising ----

/** Sixteen samples a pixel. The mark is straight-sided polygons; nothing here needs more. */
const GRID = 4;

/**
 * One square icon.
 *
 * `inset` is the share of the canvas left empty around the drawing and `corner` the superellipse
 * exponent its ground is cut to. Windows and Linux take the drawing full bleed and it wears its
 * own rounded corner; macOS asks for it in a rounded square inside a margin and cuts that corner
 * itself, so the plate's radius is skipped wherever a superellipse is given — otherwise the same
 * corner is rounded twice and the icon comes out gnawed.
 *
 * The slab stands in that square with its face in the top-left corner and its thickness running
 * down and to the right of it, so the face is a little smaller than the square. The mark is laid on the face,
 * not on the square: the crossing meets the rim exactly where the favicon has it meet the plate.
 */
function draw(size, { inset = 0, corner = Infinity } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const edge = size * inset;
  const span = size - 2 * edge;
  const lip = span * DEPTH;
  const face = span - lip;
  const left = edge;
  const top = edge;
  const half = face / 2;
  const superellipse = Number.isFinite(corner);
  const radius = superellipse ? 0 : CORNER * face;
  /** Pixels to one unit of the drawing. */
  const unit = face / UNITS;

  // How far inside the face a point is, in pixels — negative outside it — and, left in `nx` and
  // `ny`, which way the nearest rim faces. One function for both corners, so the bevel follows
  // whichever the platform cuts.
  let nx = 0;
  let ny = 0;
  function within(x, y) {
    const lx = x - left - half;
    const ly = y - top - half;
    const ax = Math.abs(lx);
    const ay = Math.abs(ly);

    if (superellipse) {
      const u = ax / half;
      const v = ay / half;
      const gx = u ** (corner - 1);
      const gy = v ** (corner - 1);
      const g = Math.hypot(gx, gy) || 1;
      nx = (Math.sign(lx) * gx) / g;
      ny = (Math.sign(ly) * gy) / g;

      return (1 - (u ** corner + v ** corner) ** (1 / corner)) * half;
    }

    const qx = ax - (half - radius);
    const qy = ay - (half - radius);
    if (qx > 0 && qy > 0) {
      const q = Math.hypot(qx, qy);
      nx = (Math.sign(lx) * qx) / q;
      ny = (Math.sign(ly) * qy) / q;

      return radius - q;
    }
    if (qx > qy) {
      nx = Math.sign(lx);
      ny = 0;

      return radius - qx;
    }
    nx = 0;
    ny = Math.sign(ly);

    return radius - qy;
  }

  // The raised pieces, sampled once: which fill stands at each sample, trimmed to the face the
  // way the favicon's clip trims it. Everything the relief needs to know — is there a piece just
  // above this point, how much of one is near it — is then a lookup rather than sixteen polygon
  // tests a time.
  //
  // A piece is trimmed twice. Once to the face, as the favicon trims it to the plate; and once to
  // the face moved up and left by the piece's own height, because the side it shows hangs that far
  // down and right of it. Trimmed only the first way, a bar that runs to the plate's right or
  // bottom edge would hang its side out past the rim and across the slab's own thickness. Trimmed
  // both ways, its side ends exactly on the rim: the bar is cut flush with the slab.
  const n = size * GRID;
  const cut = new Uint8Array(n * n);
  const rise = Math.max(1, Math.round(RISE * unit * GRID));
  const reach = (rise + 1) / GRID;
  shapes.forEach((shape, id) => {
    if (shape.kind !== 'fill') return;

    for (const run of shape.runs) {
      const points = run.map(([ux, uy]) => [left + ux * unit, top + uy * unit]);
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const i0 = Math.max(0, Math.floor(Math.min(...xs) * GRID));
      const i1 = Math.min(n - 1, Math.ceil(Math.max(...xs) * GRID));
      const j0 = Math.max(0, Math.floor(Math.min(...ys) * GRID));
      const j1 = Math.min(n - 1, Math.ceil(Math.max(...ys) * GRID));

      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = (i + 0.5) / GRID;
          const y = (j + 0.5) / GRID;
          if (inside(x, y, points) && within(x, y) > 0 && within(x + reach, y + reach) > 0) cut[j * n + i] = id;
        }
      }
    }
  });

  // The sides of each piece that show: the samples down and right of it, as far along that
  // diagonal as it stands off the plate. Walked row by row, each sample asks the one up and left
  // of it what it saw.
  const front = new Uint8Array(n * n);
  const seen = new Uint8Array(n * n);
  const since = new Uint16Array(n * n).fill(0xffff);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const at = j * n + i;
      if (cut[at]) {
        seen[at] = cut[at];
        since[at] = 0;
      } else if (i > 0 && j > 0 && since[at - n - 1] < rise) {
        seen[at] = seen[at - n - 1];
        since[at] = since[at - n - 1] + 1;
        front[at] = seen[at];
      }
    }
  }

  // And the shadow: the pieces' own outline, softened, read back from a little down and right
  // of where they stand.
  const cast = soften(
    cut.map((id) => (id ? 255 : 0)),
    n,
    Math.round(CAST.blur * unit * GRID),
  );
  const castX = rise + Math.round(CAST.dx * unit * GRID);
  const castY = rise + Math.round(CAST.dy * unit * GRID);
  const glint = Math.max(1, Math.round(GLINT * unit * GRID));
  const bevel = BEVEL * face;

  const plate = rgb(shapes[0].colour);
  const inks = shapes.map((shape) => rgb(shape.colour));

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < GRID; sy++) {
        for (let sx = 0; sx < GRID; sx++) {
          const i = px * GRID + sx;
          const j = py * GRID + sy;
          const x = (i + 0.5) / GRID;
          const y = (j + 0.5) / GRID;
          const u = (x - left) / face;
          const v = (y - top) / face;
          const at = j * n + i;

          const d = within(x, y);
          let colour;

          if (d > 0) {
            if (cut[at]) {
              // The top of a piece: its own colour, a shade lighter towards the light, with a
              // bright rim where its upper edge catches it.
              const rim = j < glint || !cut[at - glint * n];
              const lit = scale(inks[cut[at]], 1.05 - 0.13 * v);
              colour = rim ? mix(lit, WHITE, cut[at] === 1 ? 0.75 : 0.3) : lit;
            } else if (front[at]) {
              colour = mix(scale(inks[front[at]], 0.6), plate, 0.12);
            } else {
              // The face: lighter at the top than the bottom, rolled over at the rim — bright
              // where the rim faces the light and dark where it faces away — with whatever
              // shadow the pieces above throw on it.
              colour = scale(plate, 1.45 - 0.5 * v);
              colour = mix(colour, WHITE, 0.1 * Math.max(0, 1 - Math.hypot(u - 0.28, v + 0.05) / 0.85));

              if (d < bevel) {
                const turn = (1 - d / bevel) ** 2 * (-0.35 * nx - 0.94 * ny);
                colour = turn > 0 ? mix(colour, WHITE, 0.34 * turn) : scale(colour, 1 + 0.4 * turn);
              }

              const si = i - castX;
              const sj = j - castY;
              if (si >= 0 && sj >= 0) colour = scale(colour, 1 - (cast[sj * n + si] / 255) * CAST.weight);
            }
          } else {
            // Off the face: the slab's front edge and its right side, and nothing else — the
            // pieces stop at the rim. A point is on the slab's thickness if sliding it back up
            // and left lands it on the face; where it lands says which way that part of the rim
            // faces, and so how much light it gets — the right side more than the front edge,
            // with the corner turning from one to the other.
            let landed = false;
            for (let k = 1; k <= 8 && !landed; k++) landed = within(x - (lip * k) / 8, y - (lip * k) / 8) > 0;
            if (!landed) continue;

            colour = scale(plate, 0.36 + 0.34 * Math.max(0, nx) - 0.1 * v);
          }

          r += colour[0];
          g += colour[1];
          b += colour[2];
          hits++;
        }
      }

      const at = (py * size + px) * 4;
      if (!hits) continue;

      // Straight average over the samples that landed, with the rest carried in the alpha:
      // the edge pixels of the ground are the ground's colour, thinned.
      pixels[at] = Math.round(r / hits);
      pixels[at + 1] = Math.round(g / hits);
      pixels[at + 2] = Math.round(b / hits);
      pixels[at + 3] = Math.round((hits / (GRID * GRID)) * 255);
    }
  }

  return pixels;
}

// ---- the three containers ----

const chunk = (type, body) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const tagged = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tagged));

  return Buffer.concat([length, tagged, crc]);
};

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  // Every row carries the Sub filter — each byte less the one a pixel to its left. The relief is
  // lit top to bottom, so along a row most pixels equal their neighbour and the filter turns them
  // to zeros, which is what keeps a shaded icon near the size the flat one was.
  const stride = size * 4;
  const rows = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    const to = y * (stride + 1);
    rows[to] = 1;
    for (let x = 0; x < stride; x++) {
      rows[to + 1 + x] = (pixels[y * stride + x] - (x >= 4 ? pixels[y * stride + x - 4] : 0)) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG-in-ICO, which every Windows since Vista reads and which keeps the file small. */
function ico(entries) {
  const head = Buffer.alloc(6 + entries.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);

  let at = head.length;
  entries.forEach(({ size, data }, i) => {
    const row = 6 + i * 16;
    head[row] = size === 256 ? 0 : size; // 256 is written as zero, which is what the field holds
    head[row + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, row + 4); // colour planes
    head.writeUInt16LE(32, row + 6); // bits per pixel
    head.writeUInt32LE(data.length, row + 8);
    head.writeUInt32LE(at, row + 12);
    at += data.length;
  });

  return Buffer.concat([head, ...entries.map(({ data }) => data)]);
}

/** ICNS with PNG payloads, written here rather than through iconutil so any host can run this. */
function icns(entries) {
  const parts = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);

    return Buffer.concat([head, data]);
  });

  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);

  return Buffer.concat([head, body]);
}

// ---- writing them ----

mkdirSync(OUT, { recursive: true });

// Full bleed for Windows and Linux: both draw the icon into a square of their own, and a margin
// here would only make the mark smaller than everything beside it.
const square = (size) => png(size, draw(size));

writeFileSync(
  join(OUT, 'MQTTForge.ico'),
  ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: square(size) }))),
);
writeFileSync(join(OUT, 'MQTTForge.png'), square(512));

// macOS puts every icon in the same rounded square, at the same size within the canvas: an app
// that ignores the grid stands out as one that was never drawn for the platform. The margin and
// the exponent are Apple's proportions — 824 of 1024, and a superellipse rather than a rounded
// rectangle, which is the corner the system draws.
const APPLE = { inset: (1024 - 824) / 2 / 1024, corner: 5 };
// The retina types only. `icp4` and `icp5` are the 16 and 32 slots, and Apple's own reader
// treats what is in them as raw pixels however the PNG header reads — an icns carrying them
// unpacks to noise at those two sizes. Left out, macOS draws 16 and 32 down from `ic11` and
// `ic12`, which is what it does for every icon shipping @2x art and nothing smaller.
const TYPES = [
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic07', 128],
  ['ic13', 256], // 128@2x
  ['ic08', 256],
  ['ic14', 512], // 256@2x
  ['ic09', 512],
  ['ic10', 1024], // 512@2x
];

writeFileSync(
  join(OUT, 'MQTTForge.icns'),
  icns(TYPES.map(([type, size]) => ({ type, data: png(size, draw(size, APPLE)) }))),
);

// Says what it wrote, and proves the icns is one macOS will read rather than a file that only
// looks like one. Skipped where iconutil is not the platform's own tool.
for (const name of ['MQTTForge.ico', 'MQTTForge.png', 'MQTTForge.icns']) {
  console.log(`src/MqttForge.Desktop/Resources/${name}`);
}
if (process.platform === 'darwin') {
  execFileSync('iconutil', ['--convert', 'iconset', '--output', '/tmp/mqttforge.iconset', join(OUT, 'MQTTForge.icns')]);
  console.log('icns verified by iconutil');
}
