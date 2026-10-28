# Profile switching within a thread

A thread can move to another account or profile without becoming a new task. Phase 1 lets the owner choose the switch. Phase 2 adds pooled profiles that switch automatically as accounts approach their limits.

## Phase 1: owner-selected switching

Status: implemented in source. Live acceptance on the installation is pending.

### Why a switch starts a new native session

Each provider stores its native session inside the account's own home. Claude resumes a session ID from `CLAUDE_CONFIG_DIR/projects/`, and Codex resumes a thread from `CODEX_HOME`. Neither can resume a session that belongs to another account. A switch therefore closes the current session and starts a new one on the target account.

The daemon is also not the record of a thread's history. On load it rebuilds the timeline by replaying the current native session. Without extra storage, a switched thread would lose everything before the switch on its next reload.

### What a switch does

`agent.profile.switch.request` names the target provider instance and, optionally, a profile, model and reasoning option. The daemon advertises it with `server_info.features.agentProfileSwitch`. The daemon then:

1. Refuses when a turn is running, a permission request is pending, or the thread is internal or controller-managed. Running managed workers keep their own accounts and do not block the switch.
2. Reads the recorded context: at most 30 recent user and assistant messages and 50,000 characters, the same bound as a [reviewed successor](../agent-presets.md#quota-stops-and-explicit-successors). It never asks the exhausted account to summarize itself.
3. Resolves the target through the same profile admission, shared-configuration validation and skill capture as a new task.
4. Writes the thread's current timeline, followed by the switch marker, to retained switch history.
5. Closes the current session, creates a session on the target account, and registers it under the same thread ID. The new switch record, provider, configuration and persistence handle are saved together. A failure before that save leaves the thread on its previous account.
6. Appends a `profile_switch` timeline item.

The recorded context reaches the new session as appended session instructions rather than as a prompt. Switching therefore starts no turn and adds no visible message. The context costs tokens on every turn of the new session, which is why the interface discourages routine switching.

The thread keeps its ID, title, labels, goal, checklist, journal, questions and queue, because those belong to the thread rather than to the native session. A quota pause belongs to the previous account, so the switch clears it.

### Replay after a switch

The stored record keeps an ordered `profileSwitches` list. Retained history lives in `$PASEO_HOME/agent-switch-history/<agentId>/<switchId>.json`, outside the agent record directory. When the thread loads, the daemon replays the latest switch's retained history and then the current native session. Goal and queue submissions are merged into the combined stream. If the retained file is missing, the thread still loads and shows the switch marker, followed by the current session. Deleting the thread removes its retained history.

### Wire compatibility

The `profile_switch` item, the request and the feature flag are all additions. The daemon sends the item only to clients that advertise `profile_switch_timeline`. Older clients' strict timeline union would reject the item, so they don't receive it. The app offers switching only when the daemon advertises `agentProfileSwitch`.

### Interface

Choosing a profile on another account for an existing thread now offers **Switch in this thread** by default, with a warning that switching uses extra tokens and loses tool results. The existing reviewed successor remains available as **New task instead**. The timeline shows a compaction-style marker naming the previous and new account and model.

### Unavailable accounts

The load error offers the standard account and profile picker when the daemon advertises `agentProviderRecovery`. Recovery stays in the original thread and environment. It reads the original account's saved transcript with a history-only session, even when that account is disabled or marked removed. It never asks the old account to produce a summary or run a turn. The account definition stays disabled or removed.

Recovery uses the same recent-message context bound and retained-history format as an ordinary switch. It merges saved goal submissions and accepted queued messages into the recovered history. The original thread record must still match when the switch acquires its lifecycle lock; concurrent edits require a retry. A missing account definition, unreadable transcript or failed replacement leaves the original account binding intact and shows an error in the switch dialog. Restore the missing local configuration or transcript and retry. Provider-private state still cannot transfer.

### Limitations

- Tool results, attachments and provider-private reasoning do not carry over. The new model may re-read files it had already seen.
- Same-provider switches use the same recorded context as cross-provider switches. Transplanting a native transcript into another account's home would keep everything, but it depends on undocumented on-disk layouts. See phase 1b.
- Claude does not yet report quota exhaustion as `quota_exhausted`; only Codex does.

## Phase 1b: native transcript transplant

For Claude to Claude and Codex to Codex switches, copy the native session into the target account's home and resume it, falling back to recorded context when the layout check fails. This keeps tool results and full history at the cost of depending on each CLI's storage format.

## Phase 2: pooled profiles

A pool is an ordered set of account and profile candidates with a policy, such as preferring the same provider or spreading load across providers. Before admitting a turn, the daemon reads fresh provider usage and switches when the current account falls below a threshold or reports exhausted quota. Prerequisites:

- Map Claude limit errors to `quota_exhausted`.
- Never switch in the middle of a turn.
- Limit switches per hour so two partly exhausted accounts do not alternate.
- Require usage reported within the last five minutes, as the existing preset suggestion does.

Rotating several subscriptions from one provider specifically to exceed its limits may breach that provider's terms. Pooling across providers carries less of that risk. Decide the policy before building automatic switching.
