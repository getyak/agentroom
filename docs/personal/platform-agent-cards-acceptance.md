# Connected Agent card acceptance — 2026-11-14

The shared card now receives dated model/provider/thinking and quota facts from local assistants, selected shared desktop contacts, server nodes and direct A2A cards. A reread updates only the selected contact, preserving old facts after failed remote discovery. The optional `agentInfo` extension requires a supporting source; older peers and services that do not provide data remain explicitly unknown.

## Verified locally

- 55 related backend tests passed, then 25 quota/projection tests passed after adding RPC error/timeout, initialized ordering, zero balance and 60-second expiry coverage. No tests skipped.
- Personal production build, desktop type checks and 14 desktop card/IPC tests passed.
- Browser acceptance passed for source model changes, thinking, percentage windows (including zero remaining), reset time, credits, 390px layout and offline dated observations. A delayed old refresh cannot overwrite a newer model loaded by the parent.
- The existing local-card browser suite passed, including its intentionally injected 503/retry cases.
- Hidden Electron acceptance passed for remote-device enrollment, fixed IPC metadata reread, model changes, quota windows/credits, narrow layout, reload and source disconnect. The local-card native suite passed with no renderer errors.
- Real installed Codex CLI metadata discovery returned `quota.status:available` with one usage window. Only the status/count were logged; no account identity, raw response, prompt, thread or model invocation was used.
- Independent review found no P0/P1. The identified provider-attribution and late-response P2 issues were fixed and covered.

## Corrections during acceptance

The first local native run expected the generic missing-quota sentence, but the synthetic custom provider correctly returned the more specific provider-managed reason; its assertion was updated. The first remote native harness tried to click the hidden desktop navigation after a narrow-screen reload; the harness now restores desktop width before that step. Both corrected native runs passed. These were deterministic harness corrections, not unexplained retries.

## Scope and delivery

These results prove local source, synthetic browser and hidden Electron behavior plus the real local Codex quota read. They do not prove a particular remote MacBook has upgraded, that every third-party platform exposes quota, or that the installed user application has been replaced. Physical-device/account acceptance and PR/CI/installation results must be recorded separately.

Linear issue creation could not be completed because the connected Linear MCP server repeatedly failed startup/tools listing. No Linear issue was marked complete. The implementation remains reviewable through its GitHub PR.
