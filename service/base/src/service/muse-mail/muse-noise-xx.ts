import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

const PROTOCOL_NAME = Buffer.from("Noise_XX_25519_AESGCM_SHA256", "ascii");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

interface X25519KeyPair {
  publicRaw: Buffer;
  privateKey: KeyObject;
}

function generateX25519(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    publicRaw: Buffer.from(spki.subarray(spki.byteLength - 32)),
    privateKey,
  };
}

function x25519Dh(privateKey: KeyObject, peerRawPublic: Uint8Array): Buffer {
  if (peerRawPublic.byteLength !== 32) {
    throw new Error("Invalid X25519 public key length.");
  }
  const peerKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(peerRawPublic)]),
    format: "der",
    type: "spki",
  });
  return diffieHellman({ privateKey, publicKey: peerKey });
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hkdf2(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Buffer, Buffer] {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const out1 = hmacSha256(tempKey, Buffer.from([0x01]));
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Buffer.from([0x02])]));
  return [out1, out2];
}

function buildAesGcmIv(nonce: bigint): Buffer {
  const iv = Buffer.alloc(12, 0);
  iv.writeBigUInt64BE(nonce, 4);
  return iv;
}

export class NoiseAesGcmCipherState {
  private key: Buffer | null;
  private nonce = 0n;

  public constructor(key: Buffer | null = null) {
    this.key = key ? Buffer.from(key) : null;
  }

  public initializeKey(key: Buffer): void {
    if (this.key) this.key.fill(0);
    this.key = Buffer.from(key);
    this.nonce = 0n;
  }

  public hasKey(): boolean {
    return this.key !== null;
  }

  public encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (!this.key) return Buffer.from(plaintext);
    const cipher = createCipheriv("aes-256-gcm", this.key, buildAesGcmIv(this.nonce));
    if (ad.byteLength > 0) cipher.setAAD(ad);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.nonce += 1n;
    return enc;
  }

  public decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (!this.key) return Buffer.from(ciphertext);
    if (ciphertext.byteLength < 16) {
      throw new Error("Noise AES-GCM ciphertext too short.");
    }
    const body = ciphertext.subarray(0, ciphertext.byteLength - 16);
    const tag = ciphertext.subarray(ciphertext.byteLength - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, buildAesGcmIv(this.nonce));
    if (ad.byteLength > 0) decipher.setAAD(ad);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(body), decipher.final()]);
    this.nonce += 1n;
    return dec;
  }

  public wipe(): void {
    if (this.key) {
      this.key.fill(0);
      this.key = null;
    }
    this.nonce = 0n;
  }
}

export class NoiseXXInitiatorHandshake {
  private ck: Buffer;
  private h: Buffer;
  private readonly cs = new NoiseAesGcmCipherState();
  private readonly s: X25519KeyPair;
  private e: X25519KeyPair | null = null;
  private re: Buffer | null = null;

  public constructor(staticPrivatePkcs8Der?: Buffer) {
    if (PROTOCOL_NAME.byteLength <= 32) {
      const padded = Buffer.alloc(32, 0);
      PROTOCOL_NAME.copy(padded);
      this.h = padded;
    } else {
      this.h = sha256(PROTOCOL_NAME);
    }
    this.ck = Buffer.from(this.h);
    if (staticPrivatePkcs8Der) {
      const priv = createPrivateKey({ key: staticPrivatePkcs8Der, format: "der", type: "pkcs8" });
      const spki = createPublicKey(priv).export({ type: "spki", format: "der" });
      this.s = { publicRaw: Buffer.from(spki.subarray(spki.byteLength - 32)), privateKey: priv };
    } else {
      this.s = generateX25519();
    }
    this.mixHash(new Uint8Array(0));
  }

  private mixHash(data: Uint8Array): void {
    this.h = sha256(Buffer.concat([this.h, Buffer.from(data)]));
  }

  private mixKey(inputKeyMaterial: Uint8Array): void {
    const [nextCk, tempK] = hkdf2(this.ck, inputKeyMaterial);
    this.ck = nextCk;
    this.cs.initializeKey(tempK);
  }

  private encryptAndHash(plaintext: Uint8Array): Buffer {
    const ct = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  private decryptAndHash(ciphertext: Uint8Array): Buffer {
    const pt = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  // Message 1: -> e
  public writeMessage1(payload: Uint8Array = new Uint8Array(0)): Buffer {
    this.e = generateX25519();
    this.mixHash(this.e.publicRaw);
    const encPayload = this.encryptAndHash(payload);
    return Buffer.concat([this.e.publicRaw, encPayload]);
  }

  // Message 2: <- e, ee, s, es
  public readMessage2(msg2: Uint8Array): Buffer {
    if (!this.e || msg2.byteLength < 32 + 48 + 16) {
      throw new Error("Invalid Noise XX message 2 length.");
    }
    this.re = Buffer.from(msg2.subarray(0, 32));
    this.mixHash(this.re);
    this.mixKey(x25519Dh(this.e.privateKey, this.re));
    const encRs = msg2.subarray(32, 32 + 48);
    const rs = this.decryptAndHash(encRs);
    this.mixKey(x25519Dh(this.e.privateKey, rs));
    return this.decryptAndHash(msg2.subarray(32 + 48));
  }

  // Message 3: -> s, se
  public writeMessage3(payload: Uint8Array = new Uint8Array(0)): {
    msg3: Buffer;
    sendCipher: NoiseAesGcmCipherState;
    recvCipher: NoiseAesGcmCipherState;
  } {
    if (!this.e || !this.re) {
      throw new Error("Noise XX message 2 has not been processed.");
    }
    const encS = this.encryptAndHash(this.s.publicRaw);
    this.mixKey(x25519Dh(this.s.privateKey, this.re));
    const encPayload = this.encryptAndHash(payload);
    const [k1, k2] = hkdf2(this.ck, new Uint8Array(0));
    this.ck.fill(0);
    this.cs.wipe();
    return {
      msg3: Buffer.concat([encS, encPayload]),
      sendCipher: new NoiseAesGcmCipherState(k1),
      recvCipher: new NoiseAesGcmCipherState(k2),
    };
  }
}
