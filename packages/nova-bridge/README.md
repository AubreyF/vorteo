# Vorteo bridge for Nova

Private Host service for read/write control of native Vorteo work and proactive MCP Events. See the [integration guide](../../docs/nova-integration.md) for architecture, configuration, build commands, limitations and acceptance.

The integration is not accepted until it works in the intended Nova conversation. Do not expose this listener publicly or put credentials in the package.

Callback verification is cached for five minutes by the existing installation principal and callback URL, with a secret fingerprint. Unchanged refreshes do not extend that deadline. A changed signing secret requires a fresh challenge. Unsubscribe clears callback verification. Cached verification is proof of the callback challenge only, not continued account authorization.

Signing-key replacement retains prior active keys for at most five minutes, bounded by their original subscription expiration. Delivery uses space-separated signatures during that overlap. Unchanged refreshes do not extend overlap. SQLite retains both windows across process restarts; expired keys are removed during delivery or refresh. These five-minute periods are local policy, not durations specified by OpenAI.

The complete serialized UTF-8 event body must fit within 256 KiB, including IDs and metadata. Oversized new events fail before observation state commits. Oversized queued events from older builds become failed deliveries without network submission. Observer summaries contain facts and uncertainty; behavioral guidance stays in server instructions.

These rules follow the [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events). They do not establish live account access, transport compatibility, or disconnect-driven revocation. The existing single-principal authentication boundary remains unchanged.
