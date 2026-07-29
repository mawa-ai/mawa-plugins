import { Converter } from '../../converter.ts'
import { withHeaderAndFooter } from './text.ts'

export const chatwootQuickReplyConverter: Converter<'quick-reply'> = {
    type: 'quick-reply',
    convertToSourceMessage: (content) => ({
        content: withHeaderAndFooter(content.text, content),
        content_type: 'input_select',
        content_attributes: {
            items: content.options.map((option) => ({
                title: option,
                value: option,
            })),
        },
    }),
}
