// Standalone hook dispatcher entrypoint, kept for direct invocation:
//   hooks.mjs <session-start | tdd-gate | bash-gate | approval-gate | record-test | stop-gate>
// The Claude adapter no longer references this bundle — generated registrations
// call `<sddx> hook <event>` instead — so all the logic lives in the importable
// dispatcher and this file is only the process wrapper.
// Deliberately not exported: process entrypoint (see bootstrap.ts).
import { runHook } from "./lib/hookdispatch";

runHook(process.argv[2]);
