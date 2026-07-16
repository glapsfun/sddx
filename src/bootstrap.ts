// M0 placeholder for the SessionStart hook entrypoint (wired in M3).
// Must stay silent and fast: hooks have a <200 ms budget.
// Deliberately not exported: this file is a process entrypoint, and importing
// it would fire the top-level call as an import-time side effect.
function bootstrap(): void {}

bootstrap();
