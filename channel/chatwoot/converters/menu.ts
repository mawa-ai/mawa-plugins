import { Converter } from '../../converter.ts'

export const chatwootMenuConverter: Converter<'menu'> = {
    type: 'menu',
    convertToSourceMessage: (content) => ({
        content: content.text,
        content_type: 'input_select',
        content_attributes: {
            items: content.sections[0].options.map((option) => ({
                title: option.toString(),
                value: option.toString(),
            })),
        },
    }),
}
