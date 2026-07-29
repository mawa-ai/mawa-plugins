import { Converter, optionTitle } from '../../converter.ts'
import { assertAtMost, assertNotEmpty, headerAndFooter, LIMITS, truncate, truncateOptional } from '../limits.ts'
import { menuOptionId, type WhatsappConversion } from '../options.ts'

export const whatsappMenuConverter: Converter<'menu', WhatsappConversion> = {
    type: 'menu',
    convertToSourceMessage: (content, { optionToken }) => {
        assertNotEmpty(content.text, 'menu body')
        assertNotEmpty(content.button, 'menu button label')

        const rows = content.sections.reduce((total, section) => total + section.options.length, 0)
        if (rows === 0) {
            throw new Error('WhatsApp rejects a menu with no options')
        }

        // Both are structural: trimming a section or a row would hide an option the flow
        // offered, and the user would have no way to reach it.
        assertAtMost(content.sections.length, LIMITS.sections, 'sections in one list')
        assertAtMost(rows, LIMITS.rows, 'rows across all sections of one list')

        return {
            type: 'interactive',
            interactive: {
                type: 'list',
                ...headerAndFooter(content),
                body: {
                    text: truncate(content.text, LIMITS.listBody),
                },
                action: {
                    button: truncate(content.button, LIMITS.listButton),
                    sections: content.sections.map((section, sectionIndex) => ({
                        title: truncateOptional(section.title, LIMITS.sectionTitle),
                        rows: section.options.map((option, optionIndex) => {
                            const description = typeof option === 'string' ? undefined : option.description

                            return {
                                id: menuOptionId(optionToken, sectionIndex, optionIndex),
                                // Shortened for display only: the reply is matched on the id,
                                // so the flow still sees the title it wrote.
                                title: truncate(assertNotEmpty(optionTitle(option), 'menu row title'), LIMITS.rowTitle),
                                ...(description ? { description: truncate(description, LIMITS.rowDescription) } : {}),
                            }
                        }),
                    })),
                },
            },
        }
    },
}
