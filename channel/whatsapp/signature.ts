import { timingSafeEqual } from '@std/crypto/timing-safe-equal'
import { encodeHex } from '@std/encoding/hex'

/** Header Meta signs every webhook delivery with. */
export const SIGNATURE_HEADER = 'X-Hub-Signature-256'

const encoder = new TextEncoder()

/**
 * Imported keys by secret.
 *
 * `importKey` is asynchronous work on the path that answers the webhook, and the secret never
 * changes, so it is done once per secret rather than once per delivery.
 */
const keys = new Map<string, Promise<CryptoKey>>()

const keyFor = (appSecret: string): Promise<CryptoKey> => {
    const existing = keys.get(appSecret)
    if (existing) {
        return existing
    }

    const key = crypto.subtle.importKey(
        'raw',
        encoder.encode(appSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    )

    keys.set(appSecret, key)
    return key
}

/**
 * Signs a payload the way Meta does, as the value of {@linkcode SIGNATURE_HEADER}.
 *
 * Exported so that a caller sending a webhook of its own — a test harness, a replay tool —
 * produces a signature the same code verifies.
 */
export const signPayload = async (body: string, appSecret: string): Promise<string> => {
    const signature = await crypto.subtle.sign('HMAC', await keyFor(appSecret), encoder.encode(body))
    return `sha256=${encodeHex(signature)}`
}

/**
 * Checks the `X-Hub-Signature-256` of a webhook delivery against the app secret.
 *
 * Without this the webhook accepts anything posted to its URL, and since the author of an
 * inbound message is taken from the payload, a forged one can drive any user's conversation.
 *
 * @param rawBody The body exactly as it arrived. Re-serializing parsed JSON changes the
 * bytes, and with them the digest, so the signature has to be checked before parsing.
 * @param header Value of the signature header, `sha256=<hex>`.
 * @param appSecret The Meta app secret the payload was signed with.
 */
export const verifySignature = async (
    rawBody: string,
    header: string | null,
    appSecret: string,
): Promise<boolean> => {
    if (!header?.startsWith('sha256=')) {
        return false
    }

    const expected = await signPayload(rawBody, appSecret)

    // Compared in constant time: returning as soon as two digests differ would leak where,
    // which is enough to find a valid one a byte at a time. Lowercased because hex is written
    // either way and only the bytes it spells are meaningful.
    return equalStrings(header.toLowerCase(), expected)
}

/**
 * Compares two strings without leaking where they start to differ.
 *
 * Both lengths are still observable, which is fine for tokens and digests of a fixed size.
 */
export const equalStrings = (a: string, b: string): boolean => {
    const left = encoder.encode(a)
    const right = encoder.encode(b)

    // `timingSafeEqual` needs equal lengths; comparing different ones is not secret.
    return left.length === right.length && timingSafeEqual(left, right)
}
