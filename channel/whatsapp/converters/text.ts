import { Converter } from '../../converter.ts'
import type { WhatsappConversion } from '../options.ts'
import { assertNotEmpty, chunkText, LIMITS } from '../limits.ts'
import type { WhatsappMessage } from '../types.ts'

export const whatsappTextConverter: Converter<'text', WhatsappConversion> = {
    type: 'text',
    convertToSourceMessage: (content) => {
        // Graph refuses an empty body, and a flow that produced one wants to hear about it
        // rather than have the message quietly not arrive.
        assertNotEmpty(content?.trim(), 'text body')

        // Long text becomes several messages rather than a 400 from Graph.
        return chunkText(content, LIMITS.text).map((body) => ({
            type: 'text',
            text: {
                body,
                // So that a bare link renders with its preview instead of as plain text.
                preview_url: true,
            },
        }))
    },
    convertFromSourceMessage: ({ type, text, interactive, button }: WhatsappMessage) => {
        if (type === 'text') {
            return text?.body
        }

        if (type === 'interactive') {
            // Only the two reply kinds carry a title. Anything else -- a Flow completion, or
            // whatever Meta adds next -- is left to the channel, which reports it as an event
            // rather than as a message with nothing in it.
            return interactive?.button_reply?.title ?? interactive?.list_reply?.title
        }

        if (type === 'button') {
            // A quick reply on a template message, which is not an `interactive` reply.
            return button?.text ?? button?.payload
        }

        return undefined
    },
    isSourceConverter: ({ type, interactive }: WhatsappMessage) =>
        type === 'text' ||
        type === 'button' ||
        (type === 'interactive' && Boolean(interactive?.button_reply ?? interactive?.list_reply)),
}
