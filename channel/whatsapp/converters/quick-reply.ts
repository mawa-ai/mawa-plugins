import { Converter } from '../../converter.ts'
import { assertAtMost, assertNotEmpty, headerAndFooter, LIMITS, truncate } from '../limits.ts'
import { quickReplyOptionId, type WhatsappConversion } from '../options.ts'

export const whatsappQuickReplyConverter: Converter<'quick-reply', WhatsappConversion> = {
    type: 'quick-reply',
    convertToSourceMessage: (content, { optionToken }) => {
        assertNotEmpty(content.text, 'quick reply body')

        if (content.options.length === 0) {
            throw new Error('WhatsApp rejects a quick reply with no options')
        }

        // Dropping the fourth option instead would leave the bot asking about something the
        // user has no way to pick.
        assertAtMost(content.options.length, LIMITS.buttons, 'reply buttons in one message')

        return {
            type: 'interactive',
            interactive: {
                type: 'button',
                ...headerAndFooter(content),
                body: {
                    text: truncate(content.text, LIMITS.buttonBody),
                },
                action: {
                    buttons: content.options.map((option, optionIndex) => ({
                        type: 'reply',
                        reply: {
                            id: quickReplyOptionId(optionToken, optionIndex),
                            // WhatsApp shows a shortened title anyway, and the reply is
                            // matched on the id, so trimming here loses nothing.
                            title: truncate(assertNotEmpty(option, 'reply button title'), LIMITS.buttonTitle),
                        },
                    })),
                },
            },
        }
    },
}
