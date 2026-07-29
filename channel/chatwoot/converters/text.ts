import { mawa } from '../../../deps.ts'
import { Converter } from '../../converter.ts'

/**
 * Chatwoot's plain-text payload, which is what everything it has no shape of its own for
 * degrades to.
 *
 * One place decides that wire shape, so `media`, `location` and `template` cannot drift from
 * how a plain message is sent.
 *
 * @param parts Joined with blank lines, skipping whatever is absent.
 */
export const chatwootText = (...parts: (string | undefined)[]): { content_type: string; content: string } => ({
    content_type: 'text',
    content: parts.filter(Boolean).join('\n\n'),
})

/**
 * Folds a header and a footer into the body.
 *
 * Chatwoot has neither, and dropping them would lose whatever the flow put there — an order
 * number in the header, say, without which the question makes no sense.
 */
export const withHeaderAndFooter = (
    text: string,
    { header, footer }: mawa.Framing,
): string => [header, text, footer].filter(Boolean).join('\n\n')

export const chatwootTextConverter: Converter<'text'> = {
    type: 'text',
    convertToSourceMessage: (content) => chatwootText(content),
}
