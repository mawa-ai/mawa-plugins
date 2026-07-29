import { mawa } from '../../../../deps.ts'

/**
 * A flow that sends one of every portable message type, and nothing channel-specific.
 *
 * The point of the test that drives it is that this file never mentions a channel: the same
 * states have to work wherever the bot is plugged in.
 */
export default async function (context: mawa.Context): Promise<mawa.StateResult> {
    await context.send('Olá')

    await context.send({
        type: 'quick-reply',
        content: { text: 'Confirma?', options: ['Sim', 'Não'], header: 'Pedido 42' },
    })

    await context.send({
        type: 'menu',
        content: {
            text: 'Escolha',
            button: 'Ver opções',
            sections: [
                { title: 'Contas', options: ['Boleto'] },
                { title: 'Ajuda', options: [{ title: 'Atendente', description: 'Falar com humano' }] },
            ],
        },
    })

    await context.send({
        type: 'media',
        content: { kind: 'image', url: 'https://example.com/boleto.png', caption: 'Seu boleto' },
    })

    await context.send({ type: 'location', content: { latitude: -23.5, longitude: -46.6, name: 'Loja' } })

    await context.send({
        type: 'template',
        content: {
            name: 'order_update',
            language: 'pt_BR',
            parameters: ['42'],
            fallback: 'Seu pedido 42 saiu para entrega.',
        },
    })

    return { input: true }
}
