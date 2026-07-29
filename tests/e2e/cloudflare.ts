/**
 * End-to-end check of the Cloudflare adapter against the real Workers runtime.
 *
 * Bundles the fixture bot, serves it with `wrangler dev` (which runs workerd locally), and
 * drives a conversation over HTTP. This is what proves the bundle actually works there:
 * the unit tests only exercise the adapter under Deno, where a filesystem exists.
 *
 * Kept out of `deno task test` because it needs Node and downloads wrangler.
 *
 * ```sh
 * deno task e2e:cloudflare
 * ```
 */

import { assertEquals } from '@std/assert'
import { fromFileUrl } from '@std/path'
import { bundle } from 'mawa/bundle'

const PORT = 8899
const BASE_URL = `http://localhost:${PORT}`

const botDirectory = fromFileUrl(import.meta.resolve('../fixtures/worker-bot'))

const say = async (content: string, from = 'user1') => {
    const response = await fetch(`${BASE_URL}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, message: { type: 'text', content } }),
    })

    if (!response.ok) {
        throw new Error(`${response.status}: ${await response.text()}`)
    }

    const messages: { type: string; content: string }[] = await response.json()
    return messages.map((message) => message.content)
}

const waitUntilReady = async (attempts = 60) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await fetch(BASE_URL, { method: 'GET' })
            await response.body?.cancel()
            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 1000))
        }
    }

    throw new Error(`wrangler dev did not come up on port ${PORT}`)
}

const workDirectory = await Deno.makeTempDir({ prefix: 'mawa-cloudflare-e2e-' })

console.log('Bundling the fixture bot...')
await bundle({
    botDirectory,
    entrypoint: `${botDirectory}/worker.ts`,
    output: `${workDirectory}/worker.js`,
})

await Deno.writeTextFile(
    `${workDirectory}/wrangler.jsonc`,
    JSON.stringify({
        name: 'mawa-cloudflare-e2e',
        main: 'worker.js',
        compatibility_date: '2026-07-01',
        vars: { GREETING: 'ola-do-binding' },
    }),
)

console.log('Starting wrangler dev...')
const wrangler = new Deno.Command('npx', {
    args: ['--yes', 'wrangler@latest', 'dev', '--port', String(PORT), '--local'],
    cwd: workDirectory,
    stdout: 'piped',
    stderr: 'piped',
}).spawn()

let failure: unknown

try {
    await waitUntilReady()
    console.log('Running assertions against workerd...\n')

    // The configuration reads this through the generated Deno.env shim over the binding.
    assertEquals(await say('oi'), ['ola-do-binding, who are you?'])
    console.log('  ok  configuration reads a Worker binding')

    // start.name returns input: false, so farewell has to run on the same message.
    assertEquals(await say('Gabriel'), ['bye Gabriel'])
    console.log('  ok  states chain, and per-user storage survives')

    assertEquals(await say('blocked'), [])
    console.log('  ok  the usermessage hook can stop the flow')

    assertEquals(await say('ola', 'user2'), ['ola-do-binding, who are you?'])
    console.log('  ok  a new user starts at the start state')

    console.log('\nAll Cloudflare Workers checks passed.')
} catch (err) {
    failure = err
} finally {
    wrangler.kill('SIGTERM')
    await wrangler.status.catch(() => {})
    await Deno.remove(workDirectory, { recursive: true }).catch(() => {})
}

if (failure) {
    console.error('\nCloudflare Workers check failed:')
    console.error(failure)
    Deno.exit(1)
}
