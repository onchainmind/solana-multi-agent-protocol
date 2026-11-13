/**
 * Encrypted wallet management for the CLI / agent.
 *
 * Threat model & design:
 *  - A wallet file is JSON: { version, kdf, salt, iv, ciphertext, tag, pub }.
 *  - The secret key is encrypted with AES-256-GCM; the data-encryption key
 *    is derived from the user's password with scrypt (N=2^15, r=8, p=1).
 *  - The plaintext secret key NEVER touches the disk: it lives only in
 *    memory for the lifetime of the process.
 *  - GCM's auth tag is stored alongside, so wrong passwords fail cleanly.
 *
 * This file never logs secrets and never writes plaintext key material.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Keypair, PublicKey } from "@solana/web3.js";

const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const WALLET_DIR = path.join(os.homedir(), ".cypher", "wallets");

export interface WalletFile {
  version: 1;
  kdf: "scrypt";
  scrypt: { n: number; r: number; p: number };
  salt: string; // hex
  iv: string; // hex (12 bytes for GCM)
  ciphertext: string; // hex
  tag: string; // hex (16 bytes)
  pubkey: string; // base58
  createdAt: string;
}

function ensureDir(): string {
  fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  return WALLET_DIR;
}

function walletPath(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new Error(
      "Wallet name must be 1-32 chars of [A-Za-z0-9_-] (path safety)"
    );
  }
  return path.join(ensureDir(), `${name}.json`);
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
}

/** Create a new wallet, encrypted at rest. Returns the public key. */
export function createWallet(name: string, password: string): PublicKey {
  const file = walletPath(name);
  if (fs.existsSync(file)) {
    throw new Error(`Wallet '${name}' already exists`);
  }
  const kp = Keypair.generate(); // generated in-memory only
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const secret = Buffer.from(kp.secretKey); // 64 bytes
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  secret.fill(0); // wipe from memory

  const wf: WalletFile = {
    version: 1,
    kdf: "scrypt",
    scrypt: { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    tag: tag.toString("hex"),
    pubkey: kp.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(wf, null, 2), { mode: 0o600 });
  return kp.publicKey;
}

/** Load a wallet into memory (decrypts with the password). */
export function loadWallet(name: string, password: string): Keypair {
  const file = walletPath(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Wallet '${name}' not found (looked at ${file})`);
  }
  const wf = JSON.parse(fs.readFileSync(file, "utf8")) as WalletFile;
  if (wf.version !== 1 || wf.kdf !== "scrypt") {
    throw new Error("Unsupported wallet file format");
  }
  const key = deriveKey(password, Buffer.from(wf.salt, "hex"));
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(wf.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(wf.tag, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(wf.ciphertext, "hex")),
    decipher.final(),
  ]);
  const kp = Keypair.fromSecretKey(plain);
  plain.fill(0);
  if (!kp.publicKey.equals(new PublicKey(wf.pubkey))) {
    throw new Error("Wallet file integrity check failed");
  }
  return kp;
}

/** List wallet names (reads only the directory). */
export function listWallets(): string[] {
  if (!fs.existsSync(WALLET_DIR)) return [];
  return fs
    .readdirSync(WALLET_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/** Public key of a stored wallet without decrypting it. */
export function walletPubkey(name: string): PublicKey {
  const wf = JSON.parse(
    fs.readFileSync(walletPath(name), "utf8")
  ) as WalletFile;
  return new PublicKey(wf.pubkey);
}

/** Delete a stored wallet file. */
export function deleteWallet(name: string): void {
  fs.rmSync(walletPath(name));
}

export function walletDir(): string {
  return ensureDir();
}
