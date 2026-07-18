/**
 * Envelope-v2 signature verification for the target (receiving) daemon.
 *
 * The daemon signs the EXACT canonical BroadcastBody JSON bytes, transports
 * them base64-encoded as `bodyB64`, and HMACs the DECODED bytes. We
 * base64-decode, re-HMAC the same bytes, and compare in constant time.
 * No cross-language JSON field-ordering assumptions.
 *
 * (P2 hardening will swap HMAC for Ed25519: the daemon holds the private key,
 *  the target holds only the public key — a compromised target cannot forge.)
 */
import crypto from "node:crypto";

export interface EnvelopeV2 {
  schemaVersion: number;
  bodyB64: string;
  signature: { alg: string; keyId: string; value: string };
}

export interface BroadcastBody {
  schemaVersion: number;
  broadcastId: string;
  datasetId: string;
  referenceMonth: string;
  target: string;
  source: string;
  seriesIncluded: string[];
  releaseDate: string;
  contentHash: string;
  emittedAt: string;
}

const KEY_ENV = "DAEMON_HMAC_KEY";
const DEV_KEY = "dev-insecure-hmac-key-change-me";

/** Resolve the verification key for a given keyId. v1: single dev key; the
 *  map is the rotation trust set (keyId → secret). */
export function resolveKey(keyId: string): string {
  // Fail-closed in production: if a real key is configured it MUST be present.
  const env = process.env[KEY_ENV];
  if (env && env !== DEV_KEY) {
    // Production: only the configured keyId is trusted. (Rotation table TBD.)
    if (keyId !== (process.env["DAEMON_KEY_ID"] ?? "daemon-dev-1")) {
      throw new Error(`untrusted keyId '${keyId}'`);
    }
    return env;
  }
  // Dev fallback.
  return DEV_KEY;
}

/** Constant-time hex string compare (length-checked first). */
export function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length !== 64) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Verify an envelope's signature; return the decoded BroadcastBody on
 *  success, throw on failure. */
export function verifyEnvelope(env: EnvelopeV2): BroadcastBody {
  if (env.schemaVersion !== 2) {
    throw new Error(`unsupported schemaVersion ${env.schemaVersion}`);
  }
  const sig = env.signature;
  if (sig.alg !== "HMAC-SHA256") {
    throw new Error(`unsupported alg '${sig.alg}'`);
  }
  // Decode the exact bytes the daemon signed.
  const bodyBytes = Buffer.from(env.bodyB64, "base64");
  const key = resolveKey(sig.keyId);
  const expected = crypto.createHmac("sha256", key).update(bodyBytes).digest("hex");
  if (!constantTimeHexEqual(expected, sig.value)) {
    throw new Error("HMAC verification failed");
  }
  const body = JSON.parse(bodyBytes.toString("utf8")) as BroadcastBody;
  // Lightweight structural check (the JSON schema is the full contract).
  if (!body.broadcastId || !body.datasetId || !body.referenceMonth || !body.contentHash) {
    throw new Error("decoded body missing required fields");
  }
  return body;
}
