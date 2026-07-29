import { mawa } from '../deps.ts'

/**
 * Renders one message type into a channel's own shape, and reads it back.
 *
 * `Context` is whatever that channel needs to know about the message beyond its content, and
 * defaults to nothing — a channel with no such need declares its converters without one, and
 * never has to build a context it does not read.
 */
export interface Converter<Type extends keyof mawa.MessageTypes, Context = void> {
    type: Type
    // deno-lint-ignore no-explicit-any
    isSourceConverter?: (sourceMessage: any) => boolean
    /**
     * Reads the channel's own shape into message content.
     *
     * Returning `undefined` declines the message: {@linkcode Converter.isSourceConverter}
     * matches on the coarse shape, and only the conversion itself can tell that the content
     * is not there. A caller has to treat that as "not converted" rather than as empty
     * content, or a message with no content reaches the flow.
     */
    // deno-lint-ignore no-explicit-any
    convertFromSourceMessage?(sourceMessage: any): mawa.MessageTypes[Type] | undefined
    /**
     * Renders message content into the channel's own shape.
     *
     * Returns one payload, or several when the content does not fit into a single message.
     * Throws when the content cannot be represented at all, which is better than sending
     * something the user would have to guess at.
     */
    convertToSourceMessage?(content: mawa.MessageTypes[Type], context: Context): unknown | unknown[]
}

/**
 * Renders a message into the payloads one channel should send for it.
 *
 * Shared because the rules are the same wherever it is used: a `raw` message belongs to the
 * channel it names and nobody else, a converter may answer with several payloads, and a type
 * no converter claims is an error rather than silence.
 *
 * @param converters The channel's converters, tried in order.
 * @param sourceId The channel's own id, which is what a `raw` message is matched against.
 * @param message The message to render.
 * @param context Passed to the converter that claims the message.
 * @returns The payloads to send, in order. Empty when there is nothing for this channel.
 */
export const convertToSourcePayloads = <Context>(
    converters: Converter<keyof mawa.MessageTypes, Context>[],
    sourceId: string,
    message: mawa.UnknownMessage,
    context: Context,
): unknown[] => {
    if (mawa.isMessageOfType(message, 'raw')) {
        // Normally already filtered out before a channel is asked, but `send` is public, so
        // the rule is enforced wherever the message comes from.
        if (message.content.sourceId !== sourceId) {
            mawa.logger.debug('Skipping a raw message meant for another channel', {
                sourceId: message.content.sourceId,
                channel: sourceId,
            })
            return []
        }

        return [message.content.payload]
    }

    for (const converter of converters) {
        if (converter.convertToSourceMessage && mawa.isMessageOfType(message, converter.type)) {
            const payloads = converter.convertToSourceMessage(message.content, context)
            return Array.isArray(payloads) ? payloads : [payloads]
        }
    }

    throw new Error(`No converter found for message type ${message.type}`)
}

/**
 * The text of a menu option, which the SDK allows to be a bare string or an object.
 *
 * Shared because `option.toString()` on the object form yields `'[object Object]'`, and that
 * is what the user would then be asked to pick.
 */
export const optionTitle = (option: mawa.Section['options'][number]): string =>
    typeof option === 'string' ? option : option.title
