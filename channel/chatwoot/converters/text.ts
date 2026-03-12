import { Converter } from '../../converter.ts'

export const chatwootTextConverter: Converter<'text'> = {
    type: 'text',
    convertToSourceMessage: (content) => ({
        content_type: 'text',
        content,
    }),
}
