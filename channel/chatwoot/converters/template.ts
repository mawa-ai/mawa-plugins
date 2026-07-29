import { Converter } from '../../converter.ts'
import { chatwootText } from './text.ts'

/**
 * A template as its fallback text.
 *
 * Chatwoot has no notion of a pre-approved message, because it has no 24-hour window to get
 * past: an agent bot can write to a conversation whenever it likes. Sending the fallback is
 * what lets a flow use one `template` message across channels rather than branching on which
 * one it is talking to.
 */
export const chatwootTemplateConverter: Converter<'template'> = {
    type: 'template',
    convertToSourceMessage: (content) => {
        if (!content.fallback) {
            throw new Error(
                `The template '${content.name}' has no fallback text, and Chatwoot has no approved templates to ` +
                    'send instead. Give it a `fallback` to make it work on both channels.',
            )
        }

        return chatwootText(content.fallback)
    },
}
