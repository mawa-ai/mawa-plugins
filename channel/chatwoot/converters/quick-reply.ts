import { Converter } from '../../converter.ts'

export const chatwootQuickReplyConverter: Converter<'quick-reply'> = {
    type: 'quick-reply',
    convertToSourceMessage: (content) => ({
        content: content.text,
        content_type: 'input_select',
        content_attributes: {
            items: content.options.map((option) => ({
                title: option,
                value: option,
            })),
        },
    }),
}
