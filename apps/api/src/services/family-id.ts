import { Effect, Data } from "effect"
import { THREE_LETTER_WORDS, PASSWORD_WORDS } from "./wordlist"

export class HashFailure extends Data.TaggedError("HashFailure")<{
  message: string
}> {}

// Crockford Base32 (omits I, L, O, U) — unambiguous when read aloud or written.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const PBKDF2_ITERATIONS = 100_000
const HASH_PREFIX = "pbkdf2$sha256$"
const SALT_BYTES = 16
const HASH_BYTES = 32

// Dummy hash returned by lookup-on-miss to keep timing flat. Derived at module
// load from PBKDF2_ITERATIONS so the format never desyncs from real hashes.
export const DUMMY_HASH: string = (() => {
  const salt = btoa("\0".repeat(SALT_BYTES))
  const hash = btoa("\0".repeat(HASH_BYTES))
  return `${HASH_PREFIX}${PBKDF2_ITERATIONS}$${salt}$${hash}`
})()

// ── Family ID ────────────────────────────────────────────────────────────────

/**
 * Build the public Family ID: `SURNAME-WORD-HASH` (e.g. `PRADHEEP-JOY-RK97`).
 * The surname segment is uppercased and stripped of diacritics, whitespace, and
 * punctuation; the word is drawn from THREE_LETTER_WORDS; the hash is 4
 * Crockford Base32 chars. ~2M combinations per surname-word pair.
 */
export function generatePublicId(familyName: string): string {
  const surname = normaliseSurname(familyName)
  const word = pickRandom(THREE_LETTER_WORDS)
  const hash = randomCrockford(4)
  return `${surname}-${word}-${hash}`
}

export function normaliseSurname(input: string): string {
  const stripped = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
  return stripped.length === 0 ? "FAMILY" : stripped
}

// ── Password ─────────────────────────────────────────────────────────────────

/**
 * 4-word passphrase, hyphen-separated (e.g. `amber-cedar-violin-ridge`).
 * With a 128-word list this is ~28 bits of entropy — adequate for a
 * wedding-scale guest list combined with rate limiting.
 */
export function generatePassword(): string {
  return Array.from({ length: 4 }, () => pickRandom(PASSWORD_WORDS)).join("-")
}

// ── Password hashing (PBKDF2-SHA256 via WebCrypto) ───────────────────────────

export function hashPassword(
  plaintext: string,
): Effect.Effect<string, HashFailure> {
  return Effect.tryPromise({
    try: async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const bits = await derive(plaintext, salt, PBKDF2_ITERATIONS)
      return `${HASH_PREFIX}${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(bits)}`
    },
    catch: (e) => new HashFailure({ message: String(e) }),
  })
}

export function verifyPassword(
  plaintext: string,
  encoded: string,
): Effect.Effect<boolean, HashFailure> {
  return Effect.tryPromise({
    try: async () => {
      if (!encoded.startsWith(HASH_PREFIX)) return false
      const parts = encoded.slice(HASH_PREFIX.length).split("$")
      if (parts.length !== 3) return false
      const iterations = Number(parts[0])
      if (!Number.isInteger(iterations) || iterations < 1) return false
      const salt = unb64(parts[1])
      const expected = unb64(parts[2])
      const actual = await derive(plaintext, salt, iterations, expected.length)
      return constantTimeEqual(expected, actual)
    },
    catch: (e) => new HashFailure({ message: String(e) }),
  })
}

// ── Internals ────────────────────────────────────────────────────────────────

async function derive(
  plaintext: string,
  salt: Uint8Array,
  iterations: number,
  bytes: number = 32,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plaintext),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    bytes * 8,
  )
  return new Uint8Array(derived)
}

function pickRandom<T>(list: readonly T[]): T {
  // Rejection sampling avoids modulo bias for arbitrary list lengths.
  const max = Math.floor(256 / list.length) * list.length
  const buf = new Uint8Array(1)
  while (true) {
    crypto.getRandomValues(buf)
    if (buf[0]! < max) return list[buf[0]! % list.length]!
  }
}

function randomCrockford(length: number): string {
  const max = Math.floor(256 / CROCKFORD.length) * CROCKFORD.length
  const out: string[] = []
  const buf = new Uint8Array(1)
  while (out.length < length) {
    crypto.getRandomValues(buf)
    if (buf[0]! < max) out.push(CROCKFORD[buf[0]! % CROCKFORD.length]!)
  }
  return out.join("")
}

function b64(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
