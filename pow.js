// Anti-abuse liveness proof (hashcash-style). This is NOT cryptocurrency
// mining: it produces no coin and has no economic value. It solves a small
// server-issued sha256 challenge to prove a real client is running (the same
// idea as a proof-of-work CAPTCHA / Cloudflare's challenge), which stops
// headless scripts from claiming rewards. Solving it earns nothing on its own.
//
// Cost is deliberately negligible: base difficulty is ~12 leading-zero bits
// (~4k hashes, a few ms) and a proof fires only ~every 25s while actively
// watching — effectively zero CPU. Difficulty ramps only for clients the server
// already suspects of abuse, and never runs continuously.
//
// This is a plain-JS COPY of app/web/lib/pow-core.ts (makeSha256 +
// leadingZeroBits). It must stay bit-identical to the server verifier
// (src/api/continuity.ts) or extension viewers silently never earn — a drift
// guard pins it against node:crypto in app/test/extension-pow.test.ts.
//
// No Web Worker here: an MV3 service worker solves inline.

export function makeSha256() {
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const W = new Int32Array(64);
  return function sha256(msg) {
    let h0 = 0x6a09e667 | 0, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372 | 0, h3 = 0xa54ff53a | 0;
    let h4 = 0x510e527f | 0, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab | 0, h7 = 0x5be0cd19 | 0;
    const len = msg.length;
    const blocks = ((len + 8) >> 6) + 1;
    const bytes = new Uint8Array(blocks * 64);
    for (let i = 0; i < len; i++) bytes[i] = msg.charCodeAt(i) & 0xff;
    bytes[len] = 0x80;
    const bitLen = len * 8;
    bytes[blocks * 64 - 4] = (bitLen >>> 24) & 0xff;
    bytes[blocks * 64 - 3] = (bitLen >>> 16) & 0xff;
    bytes[blocks * 64 - 2] = (bitLen >>> 8) & 0xff;
    bytes[blocks * 64 - 1] = bitLen & 0xff;
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + 4 * i;
        W[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) | 0;
      }
      for (let i = 16; i < 64; i++) {
        const x = W[i - 15], y = W[i - 2];
        const s0 = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) | 0;
        const s1 = (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) | 0;
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) | 0;
        const ch = ((e & f) ^ (~e & g)) | 0;
        const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
        const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) | 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) | 0;
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    const out = new Uint8Array(32);
    const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 8; i++) {
      const v = hs[i];
      out[4 * i] = (v >>> 24) & 0xff;
      out[4 * i + 1] = (v >>> 16) & 0xff;
      out[4 * i + 2] = (v >>> 8) & 0xff;
      out[4 * i + 3] = v & 0xff;
    }
    return out;
  };
}

export function leadingZeroBits(buf) {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0) { bits += 8; continue; }
    let b = byte, n = 0;
    while (b < 0x80) { n += 1; b <<= 1; }
    return bits + n;
  }
  return bits;
}

let _sha = null;

/** Solve the challenge: find `sol` (base36) s.t. sha256(`${nonce}:${sol}`) has
 *  >= bits leading zero bits. bits<=0 returns '0' (disabled/test difficulty),
 *  matching the web solver. Not mining — the solution proves liveness, nothing
 *  is minted. */
export function solveChallenge(nonce, bits) {
  if (bits <= 0) return '0';
  if (!_sha) _sha = makeSha256();
  for (let i = 0; ; i++) {
    const sol = i.toString(36);
    if (leadingZeroBits(_sha(`${nonce}:${sol}`)) >= bits) return sol;
  }
}
