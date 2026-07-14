// strip-signature.mjs <exe> — remove an Authenticode signature from a PE file
// in place, so postject can find the SEA sentinel. Zeroes the Certificate Table
// data-directory entry, truncates the appended signature blob, and clears the
// PE checksum. Pure Node, no SDK tools.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: strip-signature.mjs <exe>'); process.exit(2); }

const buf = readFileSync(file);
const peOff = buf.readUInt32LE(0x3c);
if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') throw new Error('not a PE file');

const optStart = peOff + 24;
const magic = buf.readUInt16LE(optStart);
const ddStart = optStart + (magic === 0x20b ? 112 : 96); // PE32+ vs PE32
const certDir = ddStart + 4 * 8;                          // data directory index 4 = Security
const certOff = buf.readUInt32LE(certDir);
const certSize = buf.readUInt32LE(certDir + 4);

if (!certOff || !certSize) { console.log('no signature present — nothing to strip'); process.exit(0); }

// zero the directory entry + clear checksum (optional header CheckSum @ optStart+64)
buf.writeUInt32LE(0, certDir);
buf.writeUInt32LE(0, certDir + 4);
buf.writeUInt32LE(0, optStart + 64);

// the cert blob lives at [certOff, certOff+certSize], normally at the very end
const out = buf.subarray(0, certOff);
writeFileSync(file, out);
console.log(`stripped signature: removed ${certSize} bytes at 0x${certOff.toString(16)} (new size ${out.length})`);
