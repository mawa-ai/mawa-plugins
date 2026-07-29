import { mawa } from '../../deps.ts'

/**
 * Size limits the Cloud API enforces, and the helpers that keep payloads inside them.
 *
 * Sending past any of these is a 400 from Graph, which surfaces as a failed send in the
 * middle of a conversation. Text that is merely long is split or shortened, because the
 * user would rather read a trimmed message than none; a structural limit, such as a fourth
 * reply button, throws instead, since silently dropping an option a flow offered would make
 * the bot ask about something the user cannot pick.
 */
export const LIMITS = {
    /** Body of a plain text message. */
    text: 4096,
    /** Body of an interactive message with reply buttons. Lists get the full 4096. */
    buttonBody: 1024,
    listBody: 4096,
    header: 60,
    footer: 60,
    buttons: 3,
    buttonTitle: 20,
    sections: 10,
    /** Total rows across every section, not per section. */
    rows: 10,
    sectionTitle: 24,
    rowTitle: 24,
    rowDescription: 72,
    listButton: 20,
    caption: 1024,
    filename: 240,
} as const

/** Shortens `value` to `max` characters, marking that something was cut. */
export const truncate = (value: string, max: number): string =>
    value.length <= max ? value : value.slice(0, max - 1).trimEnd() + '…'

/** Shortens an optional value, keeping `undefined` as `undefined`. */
export const truncateOptional = (value: string | undefined, max: number): string | undefined =>
    typeof value === 'string' ? truncate(value, max) : undefined

export const assertAtMost = (count: number, max: number, what: string): void => {
    if (count > max) {
        throw new Error(`WhatsApp accepts at most ${max} ${what}, got ${count}`)
    }
}

export const assertNotEmpty = (value: string | undefined, what: string): string => {
    if (!value) {
        throw new Error(`WhatsApp rejects an empty ${what}`)
    }
    return value
}

/**
 * Splits text into pieces that each fit `max`, preferring to break where a reader would.
 *
 * Paragraph breaks first, then line breaks, then spaces, and only mid-word when none of them
 * falls late enough. A break is only taken in the second half of what is left, so that text
 * full of blank lines cannot turn into a burst of one-line messages: every piece but the last
 * carries at least half the limit.
 */
export const chunkText = (text: string, max: number): string[] => {
    if (text.length <= max) {
        return [text]
    }

    const chunks: string[] = []
    let rest = text

    while (rest.length > max) {
        // The window is one character past the limit, so a break exactly at it still counts.
        const window = rest.slice(0, max + 1)
        const earliestUseful = Math.floor(max / 2)

        const breakAt = ['\n\n', '\n', ' ']
            .map((separator) => window.lastIndexOf(separator))
            .find((index) => index >= earliestUseful) ?? -1

        const cut = breakAt > 0 ? breakAt : max
        const chunk = rest.slice(0, cut).trimEnd()

        // Only whitespace between two breaks. Nothing to send, but `rest` still has to shrink.
        if (chunk) {
            chunks.push(chunk)
        }

        rest = rest.slice(cut).trimStart()
    }

    if (rest) {
        chunks.push(rest)
    }

    return chunks
}

/**
 * The header and footer of an interactive message, shortened to what WhatsApp shows.
 *
 * Shared by the two interactive converters so the shape and the limits are stated once.
 */
export const headerAndFooter = ({ header, footer }: mawa.Framing): Record<string, unknown> => ({
    ...(header ? { header: { type: 'text', text: truncate(header, LIMITS.header) } } : {}),
    ...(footer ? { footer: { text: truncate(footer, LIMITS.footer) } } : {}),
})
