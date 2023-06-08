import { Converter } from '../../converter.ts'

export const whatsappQuickReplyConverter: Converter<'quick-reply'> = {
    type: 'quick-reply',
    convertToSourceMessage: (content) => ({
        type: 'interactive',
        interactive: {
            type: 'button',
            body: {
                text: content.text,
            },
            action: {
                buttons: content.options.map((option, optionIndex) => ({
                    type: 'reply',
                    reply: {
                        id: `${optionIndex}`,
                        title: option,
                    },
                })),
            },
        },
    }),
}
