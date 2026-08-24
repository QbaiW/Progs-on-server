import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPng(file) {
  const input = fs.readFileSync(file);
  if (!input.subarray(0, 8).equals(SIGNATURE)) throw new Error(`Not a PNG: ${file}`);
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset); offset += 4;
    const type = input.subarray(offset, offset + 4).toString("ascii"); offset += 4;
    const data = input.subarray(offset, offset + length); offset += length;
    offset += 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`Only 8-bit PNGs are supported: ${file}`);
      if (![0, 2, 4, 6].includes(colorType)) throw new Error(`Unsupported PNG color type ${colorType}: ${file}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  let sourceOffset = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset++];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[sourceOffset++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] || 0;
      const upperLeft = x >= channels ? previous[x - channels] || 0 : 0;
      row[x] = (value + (
        filter === 0 ? 0 :
        filter === 1 ? left :
        filter === 2 ? up :
        filter === 3 ? Math.floor((left + up) / 2) :
        filter === 4 ? paeth(left, up, upperLeft) : 0
      )) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (colorType === 6) {
        pixels[target] = row[source]; pixels[target + 1] = row[source + 1];
        pixels[target + 2] = row[source + 2]; pixels[target + 3] = row[source + 3];
      } else if (colorType === 2) {
        pixels[target] = row[source]; pixels[target + 1] = row[source + 1];
        pixels[target + 2] = row[source + 2]; pixels[target + 3] = 255;
      } else if (colorType === 4) {
        pixels[target] = row[source]; pixels[target + 1] = row[source];
        pixels[target + 2] = row[source]; pixels[target + 3] = row[source + 1];
      } else {
        pixels[target] = row[source]; pixels[target + 1] = row[source];
        pixels[target + 2] = row[source]; pixels[target + 3] = 255;
      }
    }
    row.copy(previous);
  }
  return { width, height, pixels };
}

function isNeutralBackground(pixels, index) {
  const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2], a = pixels[index + 3];
  if (a === 0) return true;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  // Image generation previews sometimes bake a light checkerboard into the
  // RGB channels. It is neutral and edge-connected, while the character's
  // warm khaki fill is chromatic enough to remain protected by the outline.
  return min >= 145 && max - min <= 42;
}

function removeEdgeBackground(image) {
  const { width, height, pixels } = image;
  const removed = new Uint8Array(width * height);
  const queue = [];
  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (removed[index] || !isNeutralBackground(pixels, index * 4)) return;
    removed[index] = 1;
    queue.push(index);
  };
  for (let x = 0; x < width; x += 1) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 1; y < height - 1; y += 1) { enqueue(0, y); enqueue(width - 1, y); }
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    const x = index % width, y = Math.floor(index / width);
    enqueue(x - 1, y); enqueue(x + 1, y); enqueue(x, y - 1); enqueue(x, y + 1);
  }
  for (let index = 0; index < removed.length; index += 1) {
    if (removed[index]) pixels[index * 4 + 3] = 0;
  }
  return image;
}

function alphaBounds(image) {
  const { width, height, pixels } = image;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (pixels[(y * width + x) * 4 + 3] < 8) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Sprite has no visible pixels");
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function sampleNearest(image, x, y) {
  const ix = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const index = (iy * image.width + ix) * 4;
  return image.pixels.subarray(index, index + 4);
}

function normalize(input, output) {
  const image = removeEdgeBackground(readPng(input));
  const bounds = alphaBounds(image);
  const scale = Math.min(440 / bounds.width, 462 / bounds.height);
  const drawWidth = Math.max(1, Math.round(bounds.width * scale));
  const drawHeight = Math.max(1, Math.round(bounds.height * scale));
  const destX = Math.floor((512 - drawWidth) / 2);
  const destY = Math.max(16, 494 - drawHeight);
  const pixels = Buffer.alloc(512 * 512 * 4);
  for (let y = 0; y < drawHeight; y += 1) for (let x = 0; x < drawWidth; x += 1) {
    const sourceX = bounds.minX + (x + 0.5) / scale - 0.5;
    const sourceY = bounds.minY + (y + 0.5) / scale - 0.5;
    const source = sampleNearest(image, sourceX, sourceY);
    const target = ((destY + y) * 512 + destX + x) * 4;
    pixels[target] = source[0]; pixels[target + 1] = source[1];
    pixels[target + 2] = source[2]; pixels[target + 3] = source[3];
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, encodePng(512, 512, pixels));
  return { input, output, bounds, drawWidth, drawHeight };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4); scanlines[rowStart] = 0;
    pixels.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const jobs = [
  ["pacing-left-1024.png", "pacing-left.png"],
  ["pacing-right-1024.png", "pacing-right.png"],
  ["pull-scroll-1024.png", "pull-scroll.png"],
  ["fist-bump-1024.png", "fist-bump.png"],
  ["big-heart-1024.png", "big-heart.png"],
  ["cry-cover-face-1024.png", "cry-cover-face.png"],
  ["drop-scroll-retry.png", "drop-scroll.png"],
  ["hug-star-retry.png", "hug-star.png"],
  ["magic-wand-retry.png", "magic-wand.png"],
  ["push-left-1024.png", "push-left.png"],
  ["push-right-1024.png", "push-right.png"],
  ["coding-cool-01-1024.png", "coding-01.png"],
  ["coding-cool-02-1024.png", "coding-02.png"],
];
const root = path.resolve(process.argv[2] || "public/pet/generated/actions-v2");
const outputRoot = path.resolve(process.argv[3] || path.join(root, "normalized"));
for (const [input, output] of jobs) {
  if (!fs.existsSync(path.join(root, input))) continue;
  const result = normalize(path.join(root, input), path.join(outputRoot, output));
  console.log(JSON.stringify(result));
}
