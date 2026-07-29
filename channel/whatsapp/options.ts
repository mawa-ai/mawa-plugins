import { mawa } from '../../deps.ts'
import { optionTitle } from '../converter.ts'

/**
 * Where the options of recently sent menus and quick replies are kept, each id mapped to the
 * text the flow wrote.
 *
 * WhatsApp cuts a button title to 20 characters and a row title to 24, and gives the reply
 * back with that shortened title. Matching on it would mean comparing against text the flow
 * never wrote, and two options that only differ past the cut would be indistinguishable. The
 * reply also carries the id, so remembering what each id stood for turns the reply back into
 * the option that was offered.
 */
const OPTIONS_KEY = '#wa-options'

/**
 * How many messages worth of options to remember.
 *
 * More than one, because WhatsApp never disables an old button: a user can scroll up and
 * answer a menu from earlier in the conversation, and that answer should still mean what it
 * meant then.
 */
const OPTION_SETS_KEPT = 5

type OptionSet = Record<string, string>

/**
 * What the WhatsApp converters need to know about a message beyond its content.
 *
 * Channel-local on purpose: the token exists because Graph echoes a reply's title truncated
 * and its id verbatim, which is nobody else's problem.
 */
export type WhatsappConversion = {
    /** Distinguishes this message's option ids from every other message's. */
    optionToken: string
}

/**
 * A token distinguishing one message's option ids from another's.
 *
 * Without it the second menu of a conversation would reuse the ids of the first, and a tap on
 * an old button would resolve to whichever option now sits in that position — a wrong answer
 * rather than an unrecognized one.
 */
export const newOptionToken = (): string => crypto.randomUUID().slice(0, 8)

/** Id given to the nth reply button of a quick reply. */
export const quickReplyOptionId = (token: string, optionIndex: number): string => `${token}.${optionIndex}`

/** Id given to the nth row of the given list section. */
export const menuOptionId = (token: string, sectionIndex: number, optionIndex: number): string =>
    `${token}.${sectionIndex}.${optionIndex}`

/**
 * The id-to-text map for an outgoing message, or nothing when it has no options.
 *
 * The ids come from the same helpers the converters use, given the same token, so the payload
 * and what is remembered about it cannot drift.
 */
const optionsOf = (message: mawa.UnknownMessage, token: string): OptionSet | undefined => {
    if (mawa.isMessageOfType(message, 'quick-reply')) {
        return Object.fromEntries(
            message.content.options.map((option, optionIndex) => [quickReplyOptionId(token, optionIndex), option]),
        )
    }

    if (mawa.isMessageOfType(message, 'menu')) {
        return Object.fromEntries(
            message.content.sections.flatMap((section, sectionIndex) =>
                section.options.map((option, optionIndex) => [
                    menuOptionId(token, sectionIndex, optionIndex),
                    optionTitle(option),
                ])
            ),
        )
    }

    return undefined
}

/** Records what the options of a message just sent to `userId` mean. */
export const rememberOptions = async (
    userId: mawa.UserId,
    message: mawa.UnknownMessage,
    token: string,
): Promise<void> => {
    const options = optionsOf(message, token)
    if (!options || Object.keys(options).length === 0) {
        return
    }

    const storage = mawa.config().storage
    const stored = await storage.getKv<OptionSet[]>(userId, OPTIONS_KEY) ?? []

    await storage.setKv(userId, OPTIONS_KEY, [options, ...stored].slice(0, OPTION_SETS_KEPT))
}

/**
 * The text behind a reply id, or `undefined` when nothing is known about it.
 *
 * Unknown ids are normal: the user may be answering a menu from before the options were last
 * written, or one sent by something other than this channel.
 */
export const recallOption = async (userId: mawa.UserId, id: string | undefined): Promise<string | undefined> => {
    if (!id) {
        return undefined
    }

    const stored = await mawa.config().storage.getKv<OptionSet[]>(userId, OPTIONS_KEY) ?? []

    // Newest first, though every id carries the token of the message it belongs to, so at most
    // one set can hold it.
    return stored.find((options) => id in options)?.[id]
}
