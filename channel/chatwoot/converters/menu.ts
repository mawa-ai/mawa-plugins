import { Converter, optionTitle } from '../../converter.ts'
import { withHeaderAndFooter } from './text.ts'

export const chatwootMenuConverter: Converter<'menu'> = {
    type: 'menu',
    convertToSourceMessage: (content) => ({
        content: withHeaderAndFooter(content.text, content),
        content_type: 'input_select',
        content_attributes: {
            // Every section, not just the first: Chatwoot shows one flat list, and a menu
            // written with two sections would otherwise offer only half its options here.
            items: content.sections.flatMap((section) =>
                // Title and value alike, so the reply reads as the option the flow wrote -- the
                // same text the WhatsApp channel resolves a tapped row back to.
                section.options.map(optionTitle).map((title) => ({ title, value: title }))
            ),
        },
    }),
}
