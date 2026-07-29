import { mawa } from '../../../../deps.ts'

export default async function (context: mawa.Context): Promise<mawa.StateResult> {
    await context.send(`bye ${context.author.name}`)
    return { input: true }
}
