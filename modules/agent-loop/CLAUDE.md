# modules/agent-loop/

One shared UI-free tool loop for chat/sub-agents. Public imports use index.js; internals may import only core/config and local files. Approval and permission stay in executeToolCall.

## Files and exports

AgentLoop.ts: runAgentLoop, formatAgentLoopPartial and public loop types. MessageStore.ts: ArrayMessageStore and MessageStoreLike. toolCallParser.ts: canonical parser plus private concatenated-call splitter. toolTranscriptSanitizer.ts: sanitizer before each request. TypeScript import specifiers retain .js.

Barrel values: runAgentLoop, formatAgentLoopPartial, ArrayMessageStore, parseToolCalls, sanitizeToolTranscript. Types: ModelResponse, ParsedToolCall, LoopMessage, MessageStoreLike, RunAgentLoopOptions, RunAgentLoopResult, ToolExecutionContext, ToolResultEntry, Usage, AgentLoopStopReason, AgentLoopToolOutcome, AgentLoopPartialSnapshot. splitConcatenatedToolCalls stays private.

RunAgentLoopResult retains finalText, toolsUsed, toolCallDetails, usage, iterations and stoppedBy:natural|backstop|abort. Additive stopReason/partial remain optional for old typed consumers; every new result populates stopReason. Errors reject; no stoppedBy:error.

Stop reasons: natural, iteration-limit, tool-uncertain, synthesis-budget with budgetMs, manual-stop/task-timeout/superseded, or silence/model-timeout/transport-error/model-error/hook-error with work|synthesis stage. Typed local timer errors establish deadline/silence causes, never translated strings. Unknown provider failures are model-error. Error identities remain intact; legacy promise-only non-Error reasons retain fields and original cause in an Error wrapper.

## Hook and transcript contracts

Optional awaited hooks: onIterationStart, onToolCallsParsed, onToolResults, beforeContinue, onUsage, onBackstop. Parsed calls and ask_user placeholders precede tool execution. A hook array filters calls. Result hooks follow store accounting. Hooks stay awaited during settled accounting after Stop, so original store/hook errors retain already-observed tool work. Abort blocks further model generation, compression/nudges and tools.

resolveTools runs every iteration. Sanitize transcripts before all model calls; reconstruct only calls with id/name so malformed orphan sequences do not reach APIs. minIterations uses assistant/user nudges. Backstop hardstop instructions are payload-only, never persisted in the user transcript. Synthesis requests contain no tools. reasoning_content remains in provider transcript metadata where required but never in partial snapshots.

Strings/objects are stringified and clipped to the original tool's resultBudgetChars; multimodal arrays remain intact in model transcripts. ToolExecutionContext supplies trusted resultBudgetChars/shouldAbort from runtime, never model arguments. Per-tool zero means no result cap.

Record raw outcomes at each settlement before store/hooks/stringification, ordered by monotonically assigned invocation at start. core.toolResultStatus classifies success:false, isError:true and nonempty error. Ordinary tool errors retain existing continuation policy. Typed tool timeout/abort is unknown, other throws are error. A returned value never proves a mutation: all effects are unverified. After all already-started parallel calls settle, valid results enter the transcript and observed results enter hooks. Any unknown outcome then ends the turn with stoppedBy:backstop, stopReason:tool-uncertain and a partial receipt requesting state verification, including calls without an id that would otherwise hit the orphan guard. No subsequent model call, tool batch, beforeContinue hook or optional synthesis runs in that turn.

## Partial and abort contract

callbacks.partial receives synchronous publication before awaited onBackstop and optional synthesis, at every abort exit and before error rethrows. It is never awaited; thrown observers and returned rejected promises cannot replace the real cause. Identical snapshots retain revision and are not republished. Callback/return values are separate frozen copies of names, outcomes, argument-free details, usage, iteration count and last visible text.

All displayed text/previews together share 12000 characters. Invocation identity/status survive exhausted preview space. Exclude args, raw payload, binary/base64 and hidden reasoning. Optional knownSecrets supplies actual known secret values to core.redactSecretsDeep, then maskSensitiveData, before clipping. Pattern masking is a fallback; arbitrary unknown plain strings cannot be identified as secrets. The loop never reads private model credentials.

shouldAbort must read this turn's latched state, never shared view state reset by the next turn. Existing callers retain boundary checks. Optional abortSignal enables immediate held-tool/model observation; U3 supplies a signal frozen to the owner and abortReason:manual-stop|task-timeout|superseded.

Signal Stop latches this run and stops/settles its active stream before calling any reentrant observer. It then synchronously publishes pending started calls as unknown, races held work and accounts already-settled peers in the owning transcript/hook. A held mutation is not claimed cancelled/completed. Empty accounting creates no invented assistant/tool record. Late tool promises are observed but cannot publish, resume model/hooks, append store or mutate final copies. No mutation replay or retry. Predicates raised inside a completing tool still preserve its settled accounting.

## Budgets and request ownership

limits.synthesisTimeoutMs defaults to config.model_synthesis_timeout_ms:30000, range0..600000. Zero skips synthesis and returns the published partial. Its timer starts immediately before stream creation, includes queue wait and never resets on admission/chunks. Ordinary perCallTimeoutMs/stallTimeoutMs retain existing caps.

Budget expiry is a planned backstop outcome with synthesis-budget and deterministic partial text. Model/provider/transport/hook failure publishes failed partial and rejects with original cause. Empty successful synthesis retains the optional existing salvage fallback. Optional synthesis never detaches.

Each stream call owns a settled guard and timers, including no-timer success. Late chunk/done/error/admitted or promise-rejection callbacks have no consumer/timer effect. Expiry settles/cleans/stops before external trace callbacks; Stop also stops before partial observers can synchronously start B on the same model. Induced abort cannot replace the accepted deadline/budget reason or kill B.

Heartbeat is transport activity, not semantic progress. No chunk absence is a model-health verdict. Complete/emulated providers retain ordinary deadlines and skip semantic-silence watchdogs. Structural streamMode:complete or streaming:false disables that watchdog. Actual ChatModel publicly exposes providerId; xai is the current sole complete provider, so providerId:xai is explicitly exempt without accessing private _provider/_ctx. Tests run actual ChatModel plus public xAI provider through an offline injected HTTP client. Future complete providers need public metadata or consumer-provided disabled stall limits.

## Trace and acceptance

Trace uses existing fire-and-forget sink: loop.start/end, model.done/timeout/stall, synthesis.timeout, tool.pre/post/blocked and backstop. tool.pre carries iteration, tool name and optional detail, never raw model-supplied arguments. Detail selects the first nonempty string from path/query/folder/url/filename/name, skips trimmed data: values (case-insensitive), applies core.maskSensitiveData, normalizes whitespace to one line and clips to 80 characters. No task/other-field fallback or base64 heuristics. One terminal loop.end; stop:error is trace-only. fallback:1 is empty successful synthesis or planned skipped/budget-expired partial, never caught provider failure.

AgentLoop.partial.test.ts: held tool, literal results, settlement order, preserved causes, copies, masking/bounds and fail-soft observers. AgentLoop.synthesis.test.ts: publication ordering, held hooks, total budget/queue/zero, Stop causes, late callbacks, reentrancy, actual xAI and heartbeat/deadline distinction. AgentLoop.test.ts preserves existing parsing, usage, minIterations, result budgets and empty-synthesis salvage. AgentLoop.abort.test.ts tests old predicate/tagged abort policy. AgentLoop.streamRejection.test.ts observes adapter rejections. Parser/sanitizer tests remain adjacent.

Gates: focused/full npm test, typecheck, lint, lint:obsidian. This U2 unit does not build/deploy/commit or edit consumers.


U3 consumer compatibility: `abortReason` additionally accepts an existing `AgentLoopStopReason` object so chat watchdog silence preserves the actual work/synthesis stage. The first observed reason is copied and latched.
