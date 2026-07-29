import { Converter } from '../../converter.ts'
import type { WhatsappConversion } from '../options.ts'
import { assertNotEmpty } from '../limits.ts'

/**
 * An approved template, the only thing WhatsApp accepts once the 24-hour customer service
 * window has closed.
 *
 * Free-form messages are refused with error 131047 more than 24 hours after the user's last
 * message, so a bot that has to reach a user first — an appointment reminder, an order
 * update — has to send one of these.
 */
export const whatsappTemplateConverter: Converter<'template', WhatsappConversion> = {
    type: 'template',
    convertToSourceMessage: (content) => {
        // `fallback` is for channels that have no approved templates; here the template itself
        // is what gets sent, so a name and a language are still required.
        assertNotEmpty(content.name, 'template name')
        assertNotEmpty(content.language, 'template language')

        if (content.components && content.parameters) {
            throw new Error('A template takes either parameters or components, not both')
        }

        const components = content.components ?? (content.parameters?.length
            ? [{
                type: 'body',
                parameters: content.parameters.map((parameter) => ({ type: 'text', text: String(parameter) })),
            }]
            : undefined)

        return {
            type: 'template',
            template: {
                name: content.name,
                language: { code: content.language },
                ...(components ? { components } : {}),
            },
        }
    },
}
