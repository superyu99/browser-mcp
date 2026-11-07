// Keep the common knobs here so the server needs no command-line argument parsing.
export const CDP_HTTP_URL = process.env.BROWSER_CDP_URL ?? "http://127.0.0.1:9222";
export const CDP_COMMAND_TIMEOUT_MS = 15_000;
export const PICK_ELEMENT_TIMEOUT_MS = 120_000;
export const MAX_EVALUATE_CHARS = 20_000;
export const MAX_HTML_CHARS = 8_000;
export const MAX_CONSOLE_ENTRIES = 500;
export const MAX_NETWORK_ENTRIES = 500;
export const DEFAULT_RESULT_LIMIT = 50;
//# sourceMappingURL=config.js.map