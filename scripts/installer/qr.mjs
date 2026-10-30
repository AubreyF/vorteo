// A small QR code encoder for the installer's finish screen, so a phone can open the
// Tailscale address. Byte mode only, versions 1 to 10 (up to 213 bytes at level M), which
// covers any installation address. No dependencies: install.sh runs it straight from the
// fetched release before anything is installed.
//
// Usage: node scripts/installer/qr.mjs <text> [--max-width <columns>]
// Prints the code with Unicode half blocks and exits 0. Exits 5 without printing when the
// code would be wider than --max-width, so the caller can skip it on a narrow terminal.
import { isMainModule } from "../is-main-module.mjs";

/** Error correction levels with their two format bits. */
export const ECC = {
  L: { index: 0, formatBits: 1 },
  M: { index: 1, formatBits: 0 },
  Q: { index: 2, formatBits: 3 },
  H: { index: 3, formatBits: 2 },
};

// ISO/IEC 18004 table 9 for versions 1 to 10, indexed [level][version - 1].
const ECC_CODEWORDS_PER_BLOCK = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
];
const ERROR_CORRECTION_BLOCKS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
];
export const MAX_VERSION = 10;

/** Number of modules that hold data and error correction bits, including remainder bits. */
export function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function dataCodewordCapacity(version, ecc) {
  const blocks = ERROR_CORRECTION_BLOCKS[ecc.index][version - 1];
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[ecc.index][version - 1];
  return Math.floor(rawDataModules(version) / 8) - blocks * eccPerBlock;
}

export function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

// Reed-Solomon arithmetic over GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
export function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

export function reedSolomonDivisor(degree) {
  const result = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function reedSolomonRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

function chooseVersion(byteLength, ecc) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const lengthBits = version < 10 ? 8 : 16;
    const neededBits = 4 + lengthBits + byteLength * 8;
    if (neededBits <= dataCodewordCapacity(version, ecc) * 8) return version;
  }
  throw new Error(`Text is too long for a version ${MAX_VERSION} QR code`);
}

function encodeData(bytes, version, ecc) {
  const bits = [];
  const append = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  const capacityBits = dataCodewordCapacity(version, ecc) * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

/** Splits data into blocks, appends each block's error correction and interleaves them. */
export function addErrorCorrection(data, version, ecc) {
  const blockCount = ERROR_CORRECTION_BLOCKS[ecc.index][version - 1];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[ecc.index][version - 1];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const divisor = reedSolomonDivisor(eccLength);
  const blocks = [];
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const length = shortBlockLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const remainder = reedSolomonRemainder(block, divisor);
    // Short blocks get a placeholder so every block has the same length while interleaving.
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(remainder));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLength - eccLength || j >= shortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The 15 format bits, error correction level and mask with BCH bits, already masked. */
export function formatBits(ecc, mask) {
  const data = (ecc.formatBits << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The 18 version bits for versions 7 and up. */
export function versionBits(version) {
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => Array(this.size).fill(false));
  }

  setFunction(x, y, dark) {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ]) {
      this.drawPattern(cx, cy, 4, (distance) => distance !== 2 && distance !== 4);
    }
    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        const nearFinder =
          (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
        if (!nearFinder) {
          this.drawPattern(positions[i], positions[j], 2, (distance) => distance !== 1);
        }
      }
    }
    // Reserve the format areas now; drawFormat fills them once a mask is chosen.
    this.drawFormat(0);
    this.drawVersion();
  }

  drawPattern(cx, cy, radius, isDark) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, isDark(Math.max(Math.abs(dx), Math.abs(dy))));
        }
      }
    }
  }

  drawFormat(bits) {
    const { size } = this;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    this.setFunction(8, size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    const bits = versionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  /** Places codewords in the two-column zigzag, skipping function modules. */
  drawCodewords(codewords) {
    let index = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.reserved[y][x] && index < codewords.length * 8) {
            this.modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
            index++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const test = MASKS[mask];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.reserved[y][x] && test(x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  penalty() {
    const { size, modules } = this;
    let score = 0;
    const lines = [];
    for (let i = 0; i < size; i++) {
      lines.push(modules[i]);
      lines.push(modules.map((row) => row[i]));
    }
    const finderLike = [true, false, true, true, true, false, true];
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // A finder-like 1:1:3:1:1 run with four light modules on either side.
      for (let i = 0; i + 7 <= size; i++) {
        if (!finderLike.every((dark, k) => line[i + k] === dark)) continue;
        const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !line[i - k]);
        const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= size || !line[i + 7 + k]);
        if (lightBefore || lightAfter) score += 40;
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
        if (x + 1 < size && y + 1 < size) {
          const color = modules[y][x];
          if (
            modules[y][x + 1] === color &&
            modules[y + 1][x] === color &&
            modules[y + 1][x + 1] === color
          ) {
            score += 3;
          }
        }
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/**
 * Encodes `text` as UTF-8 bytes and returns `{ version, mask, size, modules,
 * functionModules }`, where `modules[y][x]` is true for a dark module and
 * `functionModules[y][x]` for a finder, timing, alignment, format or version module. Picks the smallest version that fits and the
 * mask with the lowest penalty.
 */
export function encodeQr(text, { ecc = ECC.M, mask: forcedMask } = {}) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  const version = chooseVersion(bytes.length, ecc);
  const codewords = addErrorCorrection(encodeData(bytes, version, ecc), version, ecc);
  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(codewords);
  let best = forcedMask;
  if (best === undefined) {
    let bestScore = Infinity;
    for (let mask = 0; mask < MASKS.length; mask++) {
      matrix.applyMask(mask);
      matrix.drawFormat(formatBits(ecc, mask));
      const score = matrix.penalty();
      if (score < bestScore) {
        bestScore = score;
        best = mask;
      }
      matrix.applyMask(mask);
    }
  }
  matrix.applyMask(best);
  matrix.drawFormat(formatBits(ecc, best));
  return {
    version,
    mask: best,
    size: matrix.size,
    modules: matrix.modules,
    functionModules: matrix.reserved,
  };
}

/** Width in terminal columns of `renderTerminal` output. */
export function terminalWidth(qr, quietZone = 4) {
  return qr.size + quietZone * 2;
}

/**
 * Renders two module rows per line with upper half blocks. Colors are explicit (black on
 * white) so the code scans on light and dark terminal themes alike.
 */
export function renderTerminal(qr, quietZone = 4) {
  const span = qr.size + quietZone * 2;
  const dark = (x, y) => {
    const mx = x - quietZone;
    const my = y - quietZone;
    return mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx];
  };
  const lines = [];
  for (let y = 0; y < span; y += 2) {
    let line = "";
    for (let x = 0; x < span; x++) {
      const foreground = dark(x, y) ? 30 : 97;
      const background = dark(x, y + 1) ? 40 : 107;
      line += `\u001b[${foreground};${background}m▀`;
    }
    lines.push(`${line}\u001b[0m`);
  }
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const text = argv[0];
  if (!text) {
    process.stderr.write("Usage: node scripts/installer/qr.mjs <text> [--max-width <columns>]\n");
    return 2;
  }
  const widthIndex = argv.indexOf("--max-width");
  const maxWidth = widthIndex === -1 ? Infinity : Number(argv[widthIndex + 1]);
  const qr = encodeQr(text);
  if (terminalWidth(qr) > maxWidth) return 5;
  process.stdout.write(renderTerminal(qr));
  return 0;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
