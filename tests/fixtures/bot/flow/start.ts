import { mawa } from '../../../../deps.ts'

export default async function (context: mawa.Context): Promise<mawa.StateResult> {
    await context.send(`echo: ${context.message.content}`)
    return { input: true }
}
