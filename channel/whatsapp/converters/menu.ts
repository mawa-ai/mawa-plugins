import { Converter } from '../../converter.ts'

export const whatsappMenuConverter: Converter<'menu'> = {
    type: 'menu',
    convertToSourceMessage: (content) => ({
        type: 'interactive',
        interactive: {
            type: 'list',
            body: {
                text: content.text,
            },
            action: {
                button: content.button,
                sections: content.sections.map((section, sectionIndex) => ({
                    title: section.title,
                    rows: section.options.map((option, optionIndex) => {
                        if (typeof option === 'string') {
                            return {
                                id: `${sectionIndex}.${optionIndex}`,
                                title: option,
                            }
                        } else {
                            return {
                                id: `${sectionIndex}.${optionIndex}`,
                                title: option.title,
                                description: option.description,
                            }
                        }
                    }),
                })),
            },
        },
    }),
}
