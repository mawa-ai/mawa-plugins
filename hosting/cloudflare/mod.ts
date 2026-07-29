import { createRequestHandler } from 'mawa/hosting'

/**
 * The part of Cloudflare's `ExecutionContext` this adapter uses.
 *
 * Declared structurally on purpose: depending on `@cloudflare/workers-types` would redeclare
 * `Request`, `Response` and friends as globals, which conflicts with the types Deno already
 * provides to everyone else consuming this package.
 */
export type ExecutionContext = {
    waitUntil: (promise: Promise<unknown>) => void
}

export type CloudflareOptions = {
    /**
     * Bot directory, used only when the bundle carries no registry.
     *
     * On Workers the bot is bundled ahead of time by `deno run -A jsr:@mawa/sdk/bundle`, which
     * installs a registry, so this is normally left out.
     */
    directory?: string
}

export type FetchHandler = (request: Request, env?: unknown, ctx?: ExecutionContext) => Promise<Response>

/**
 * Builds a Worker `fetch` handler for a bot.
 *
 * ```ts
 * export default { fetch: createFetchListener() }
 * ```
 *
 * Bundle it with `deno run -A jsr:@mawa/sdk/bundle --bot ./bot --entry ./bot/worker.ts`, which
 * resolves the bot's states ahead of time. Workers fixes its module graph when the bundle is
 * built, so the SDK cannot discover `flow/*.ts` at request time the way it does under Deno.
 *
 * Secrets reach `mawa.config.ts` through a `Deno.env` shim over the Worker's bindings that the
 * generated bundle installs, so a configuration written for Deno needs no changes.
 *
 * Webhook channels are acknowledged as soon as the message is accepted and their flow finishes
 * in `ctx.waitUntil`, so providers that retry on a slow response get their prompt 200. Channels
 * that build their reply into the response, such as the web chat, are still awaited.
 */
export const createFetchListener = (options: CloudflareOptions = {}): FetchHandler => {
    const handle = createRequestHandler({ directory: options.directory })

    return (request: Request, _env?: unknown, ctx?: ExecutionContext): Promise<Response> =>
        // Not destructured: waitUntil is bound to the context.
        handle(request, { defer: ctx && ((work) => ctx.waitUntil(work)) })
}
