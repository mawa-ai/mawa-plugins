import { Converter } from '../../converter.ts'

export const whatsappTextConverter: Converter<'text'> = {
    type: 'text',
    convertToSourceMessage: (content) => ({
        type: 'text',
        text: {
            body: content,
        },
    }),
    convertFromSourceMessage: ({ type, text, interactive }) => {
        if (type === 'text') {
            return text.body
        } else if (type === 'interactive') {
            return interactive.button_reply?.title || interactive.list_reply?.title
        }
    },
    isSourceConverter: ({ type }) => type === 'text' || type === 'interactive',
}
