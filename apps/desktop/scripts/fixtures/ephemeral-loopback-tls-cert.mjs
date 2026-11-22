import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function encodeDerLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(body.length), body]);
}

function derSequence(items) {
  return derTlv(0x30, Buffer.concat(items));
}

function derSet(items) {
  return derTlv(0x31, Buffer.concat(items));
}

function derInteger(bytes) {
  let buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  while (buf.length > 1 && buf[0] === 0 && (buf[1] & 0x80) === 0) {
    buf = buf.subarray(1);
  }
  if (buf[0] & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return derTlv(0x02, buf);
}

function derOid(numbers) {
  const out = [40 * numbers[0] + numbers[1]];
  for (let i = 2; i < numbers.length; i += 1) {
    let value = numbers[i];
    const encoded = [value & 0x7f];
    value = Math.floor(value / 128);
    while (value > 0) {
      encoded.unshift((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    out.push(...encoded);
  }
  return derTlv(0x06, out);
}

function derBitString(bytes) {
  return derTlv(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
}

function derOctetString(bytes) {
  return derTlv(0x04, bytes);
}

function derUtcTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return derTlv(0x17, Buffer.from(text, "ascii"));
}

function derCommonName(cn) {
  return derSequence([
    derSet([
      derSequence([
        derOid([2, 5, 4, 3]),
        derTlv(0x0c, Buffer.from(cn, "utf8")),
      ]),
    ]),
  ]);
}

function toPem(label, derBytes) {
  const lines = derBytes.toString("base64").match(/.{1,64}/g) ?? [];
  const header = `-----BEGIN ${label}-----`;
  const footer = `-----END ${label}-----`;
  return `${header}\n${lines.join("\n")}\n${footer}\n`;
}

export function generateEphemeralLoopbackTlsCertificate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  // sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const sha256WithRsaAlg = derSequence([
    derOid([1, 2, 840, 113549, 1, 1, 11]),
    Buffer.from([0x05, 0x00]),
  ]);

  const now = Date.now();
  const validity = derSequence([
    derUtcTime(new Date(now - 5 * 60_000)),
    derUtcTime(new Date(now + 2 * 3600_000)),
  ]);
  const name = derCommonName("127.0.0.1");

  // BasicConstraints: critical, cA=TRUE
  const basicConstraintsExt = derSequence([
    derOid([2, 5, 29, 19]),
    Buffer.from([0x01, 0x01, 0xff]),
    derOctetString(derSequence([Buffer.from([0x01, 0x01, 0xff])])),
  ]);

  // SubjectAltName: dNSName=localhost, iPAddress=127.0.0.1
  const sanValue = derSequence([
    derTlv(0x82, Buffer.from("localhost", "ascii")),
    derTlv(0x87, Buffer.from([127, 0, 0, 1])),
  ]);
  const sanExt = derSequence([
    derOid([2, 5, 29, 17]),
    derOctetString(sanValue),
  ]);

  const tbsCertificate = derSequence([
    derTlv(0xa0, derInteger([0x02])), // v3
    derInteger(crypto.randomBytes(16)),
    sha256WithRsaAlg,
    name,
    validity,
    name,
    spkiDer,
    derTlv(0xa3, derSequence([basicConstraintsExt, sanExt])),
  ]);

  const signature = crypto.sign("sha256", tbsCertificate, privateKey);
  const certDer = derSequence([tbsCertificate, sha256WithRsaAlg, derBitString(signature)]);
  const certPem = toPem("CERTIFICATE", certDer);

  const parsed = new crypto.X509Certificate(certPem);
  if (!parsed.verify(publicKey)) {
    throw new Error("Generated loopback X.509 certificate failed self-signature verification.");
  }

  return { certPem, keyPem };
}

function cliArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outDir = cliArgument("--out-dir");
  if (!outDir) {
    throw new Error("Usage: node ephemeral-loopback-tls-cert.mjs --out-dir PATH");
  }
  fs.mkdirSync(outDir, { recursive: true });
  const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();
  const certPath = path.join(outDir, "loopback-ca-cert.pem");
  const keyPath = path.join(outDir, "loopback-key.pem");
  fs.writeFileSync(certPath, certPem, "utf8");
  fs.writeFileSync(keyPath, keyPem, "utf8");
  console.log(JSON.stringify({ certPath: path.resolve(certPath), keyPath: path.resolve(keyPath) }));
}
