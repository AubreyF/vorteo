import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  addErrorCorrection,
  dataCodewordCapacity,
  ECC,
  encodeQr,
  formatBits,
  reedSolomonDivisor,
  reedSolomonRemainder,
  renderTerminal,
  terminalWidth,
  versionBits,
} from "./qr.mjs";

const qrScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "qr.mjs");

/** Reads the data codewords back out of a symbol: unmask, walk the zigzag, de-interleave. */
function decodeCodewords(qr) {
  const { size, modules, functionModules } = qr;
  const masks = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
        if (!functionModules[y][x]) bits.push(modules[y][x] !== masks[qr.mask](x, y));
      }
    }
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | Number(bit), 0));
  }
  return codewords;
}

function readByteMode(dataCodewords, version) {
  const bits = dataCodewords.flatMap((byte) =>
    Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1),
  );
  const read = (start, length) =>
    bits.slice(start, start + length).reduce((v, b) => (v << 1) | b, 0);
  assert.equal(read(0, 4), 0b0100, "byte mode indicator");
  const lengthBits = version < 10 ? 8 : 16;
  const length = read(4, lengthBits);
  const bytes = Array.from({ length }, (_, i) => read(4 + lengthBits + i * 8, 8));
  return Buffer.from(bytes).toString("utf8");
}

function readFormat(qr) {
  const bit = (x, y) => (qr.modules[y][x] ? 1 : 0);
  let value = 0;
  // Bits 0 to 7 run down column 8 then along row 8 next to the top-left finder.
  const positions = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  positions.forEach(([x, y], i) => (value |= bit(x, y) << i));
  return value;
}

describe("QR encoder", () => {
  test("format and version bits match the published tables", () => {
    assert.equal(formatBits(ECC.M, 0), 0b101010000010010);
    assert.equal(formatBits(ECC.L, 0), 0b111011111000100);
    assert.equal(formatBits(ECC.H, 7), 0b000100000111011);
    assert.equal(versionBits(7), 0x07c94);
    assert.equal(versionBits(10), 0x0a4d3);
  });

  test("Reed-Solomon matches the HELLO WORLD 1-M example", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    assert.deepEqual(
      reedSolomonRemainder(data, reedSolomonDivisor(10)),
      [196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
    );
    assert.deepEqual(
      addErrorCorrection([...data], 1, ECC.M).slice(16),
      [196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
    );
  });

  test("capacities match the published tables", () => {
    assert.equal(dataCodewordCapacity(1, ECC.L), 19);
    assert.equal(dataCodewordCapacity(5, ECC.Q), 62);
    assert.equal(dataCodewordCapacity(10, ECC.M), 216);
  });

  for (const [text, ecc] of [
    ["https://vorteo.tail1234.ts.net", ECC.M],
    ["https://a-much-longer-host-name.tailnet-abcd.ts.net/welcome?from=installer", ECC.M],
    ["x".repeat(120), ECC.Q],
    ["ü".repeat(40), ECC.H],
    ["y".repeat(200), ECC.M],
  ]) {
    test(`round-trips ${text.length} characters at version ${encodeQr(text, { ecc }).version}`, () => {
      const qr = encodeQr(text, { ecc });
      assert.equal(qr.size, qr.version * 4 + 17);
      assert.equal(readFormat(qr), formatBits(ecc, qr.mask));
      const codewords = decodeCodewords(qr);
      const data = [];
      dataLayout(qr.version, ecc).forEach((dataIndex, position) => {
        if (dataIndex !== null) data[dataIndex] = codewords[position];
      });
      assert.equal(readByteMode(data, qr.version), text);
    });
  }

  test("finder patterns sit in three corners", () => {
    const qr = encodeQr("finder");
    const isFinder = (cx, cy) => {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (qr.modules[cy + dy][cx + dx] !== (distance !== 2)) return false;
        }
      }
      return true;
    };
    assert.ok(isFinder(3, 3));
    assert.ok(isFinder(qr.size - 4, 3));
    assert.ok(isFinder(3, qr.size - 4));
  });

  test("a regression hash for an address decoded by an independent reader", () => {
    // This symbol was decoded correctly by macOS CoreImage's QR detector.
    const qr = encodeQr("https://vorteo.tail1234.ts.net");
    const rowText = (row) => row.map(Number).join("");
    const rows = qr.modules.map(rowText).join("\n");
    assert.equal(qr.version, 3);
    assert.equal(qr.mask, 2);
    assert.equal(createHash("sha256").update(rows).digest("hex").slice(0, 16), GOLDEN_HASH);
  });

  test("terminal output uses two module rows per line inside a quiet zone", () => {
    const qr = encodeQr("https://vorteo.tail1234.ts.net");
    const lines = renderTerminal(qr).trimEnd().split("\n");
    assert.equal(lines.length, Math.ceil(terminalWidth(qr) / 2));
    assert.equal(terminalWidth(qr), 37);
  });

  test("the command skips the code when the terminal is too narrow", () => {
    const narrow = spawnSync(
      process.execPath,
      [qrScript, "https://vorteo.tail1234.ts.net", "--max-width", "30"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(narrow.status, 5);
    assert.equal(narrow.stdout, "");
    const wide = spawnSync(
      process.execPath,
      [qrScript, "https://vorteo.tail1234.ts.net", "--max-width", "80"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(wide.status, 0);
    assert.match(wide.stdout, /▀/);
  });

  test("text that does not fit version 10 is refused", () => {
    assert.throws(() => encodeQr("z".repeat(400)), /too long/);
  });
});

const BLOCKS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
];

/**
 * For each interleaved codeword position, the index of the data codeword stored there, or
 * null for error correction. Short blocks come first and hold one data codeword fewer.
 */
function dataLayout(version, ecc) {
  const capacity = dataCodewordCapacity(version, ecc);
  const total = addErrorCorrection(Array(capacity).fill(0), version, ecc).length;
  const blockCount = BLOCKS[ecc.index][version - 1];
  const eccLength = (total - capacity) / blockCount;
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount);
  const blocks = [];
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = Array.from({ length }, (_, k) => offset + k);
    offset += length;
    if (i < shortBlocks) block.push(null);
    blocks.push(block.concat(Array(eccLength).fill(null)));
  }
  const layout = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLength - eccLength || j >= shortBlocks) layout.push(blocks[j][i]);
    }
  }
  return layout;
}

const GOLDEN_HASH = "bf7e58e5a79370a5";
