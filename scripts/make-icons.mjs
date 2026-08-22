// Draws the app icons from the one mark, so the tab, the Dock and the taskbar all wear the
// drawing in web/public/favicon.svg rather than three copies of it that drift apart.
//
//   node scripts/make-icons.mjs
//
// Writes src/MqttForge.Desktop/Resources: an .ico for the Windows executable, a .png for the
// GTK window on Linux, and an .icns for the macOS bundle. The three are checked in — this runs
// when the mark changes, not on every build.
//
// The rasteriser understands only the vocabulary the favicon uses: one full-bleed rect, one
// stroked path of straight runs, one filled polygon, all on a 24-unit square. Anything else in
// that file is an error rather than a silent omission — an icon that quietly lost half its
// drawing is worse than a build that stopped.
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
const tags = [...svg.matchAll(/<(rect|path)\b[^>]*>/g)].map(([tag]) => tag);

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
    return { kind: 'ground', colour: attr(tag, 'fill') };
  }

  const d = attr(tag, 'd');
  const stroke = attr(tag, 'stroke');

  return stroke && stroke !== 'none'
    ? { kind: 'strokes', runs: runs(d), colour: stroke, width: Number(attr(tag, 'stroke-width')) }
    : { kind: 'fill', runs: runs(d), colour: attr(tag, 'fill') };
});

const expected = ['ground', 'strokes', 'fill'];
if (shapes.map((shape) => shape.kind).join() !== expected.join()) {
  throw new Error(`${SOURCE} is no longer ${expected.join(' + ')}; the rasteriser needs updating`);
}

const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

// ---- the drawing, asked one point at a time ----

/** Perpendicular distance to a segment, or Infinity past either end: butt caps, as drawn. */
function toSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const along = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
  if (along < 0 || along > 1) return Infinity;

  return Math.abs((x - ax) * dy - (y - ay) * dx) / Math.hypot(dx, dy);
}

/** Crossing number, which is enough for the one convex cell this mark has. */
function inside(x, y, points) {
  let is = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) is = !is;
  }

  return is;
}

/**
 * The colour at a point in the drawing's own units, or null where the ground is not laid.
 *
 * `strokes` stands in for the drawing's stroked path, so a small icon can be drawn with the
 * hinted width without a second copy of the shape list.
 */
function colourAt(x, y, strokes) {
  let colour = null;

  for (const original of shapes) {
    const shape = original.kind === 'strokes' ? strokes : original;
    if (shape.kind === 'ground') colour = shape.colour;
    if (shape.kind === 'strokes') {
      const on = shape.runs.some((run) =>
        run.some((point, i) => i > 0 && toSegment(x, y, run[i - 1], point) <= shape.width / 2),
      );
      if (on) colour = shape.colour;
    }
    if (shape.kind === 'fill' && shape.runs.some((run) => inside(x, y, run))) colour = shape.colour;
  }

  return colour;
}

// ---- rasterising ----

/** Sixteen samples a pixel. The mark is four straight strokes; nothing here needs more. */
const GRID = 4;

/**
 * One square icon.
 *
 * `inset` is the share of the canvas left empty around the drawing and `corner` the superellipse
 * exponent its ground is cut to — 0 and Infinity give the full-bleed square Windows and Linux
 * want, and macOS asks for the drawing in a rounded square inside a margin.
 */
function draw(size, { inset = 0, corner = Infinity } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const edge = size * inset;
  const span = size - 2 * edge;
  const half = span / 2;
  // Below 48 the strokes are a pixel and a half wide and land on nothing: two grey rows where
  // the drawing says one white one. Rounded to whole pixels they are crisp, and the mark reads
  // as a diyez in a window list rather than as a smudge. Above that the stroke is wide enough
  // that its own edges do the work.
  const scale = span / UNITS;
  const hinted = size < 48 ? Math.max(1, Math.round(shapes[1].width * scale)) / scale : shapes[1].width;
  const width = { ...shapes[1], width: hinted };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < GRID; sy++) {
        for (let sx = 0; sx < GRID; sx++) {
          const x = px + (sx + 0.5) / GRID;
          const y = py + (sy + 0.5) / GRID;

          // Outside the ground's shape: the margin, and the corners the superellipse cuts off.
          if (x < edge || x > size - edge || y < edge || y > size - edge) continue;
          if (Number.isFinite(corner)) {
            const u = Math.abs((x - edge - half) / half);
            const v = Math.abs((y - edge - half) / half);
            if (u ** corner + v ** corner > 1) continue;
          }

          const colour = colourAt(((x - edge) / span) * UNITS, ((y - edge) / span) * UNITS, width);
          if (!colour) continue;

          const [cr, cg, cb] = rgb(colour);
          r += cr;
          g += cg;
          b += cb;
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
  // Every row is written unfiltered: the drawing is flat colour, so the filters buy nothing.
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
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
