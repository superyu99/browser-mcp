import { MAX_EVALUATE_CHARS } from "./config.js";
export function clip(text, max = MAX_EVALUATE_CHARS) {
    return text.length <= max ? text : `${text.slice(0, max)}\n… clipped ${text.length - max} chars`;
}
export function jsonText(value, max = MAX_EVALUATE_CHARS) {
    try {
        return clip(JSON.stringify(value, null, 2), max);
    }
    catch {
        return clip(String(value), max);
    }
}
export function valuePreview(remote) {
    if ("value" in remote)
        return typeof remote.value === "string" ? remote.value : jsonText(remote.value, 2_000);
    if (typeof remote.unserializableValue === "string")
        return remote.unserializableValue;
    if (typeof remote.description === "string")
        return clip(remote.description, 2_000);
    return String(remote.type ?? "undefined");
}
export function pickHeaders(headers) {
    if (!headers || typeof headers !== "object")
        return undefined;
    const wanted = new Set(["accept", "content-type", "content-length", "cache-control", "etag", "location", "origin", "referer", "user-agent"]);
    const selected = Object.entries(headers)
        .filter(([key]) => wanted.has(key.toLowerCase()))
        .slice(0, 20)
        .map(([key, value]) => [key, String(value)]);
    return selected.length ? Object.fromEntries(selected) : undefined;
}
export function initiatorPreview(initiator) {
    if (!initiator || typeof initiator !== "object")
        return undefined;
    const value = initiator;
    const stack = value.stack;
    const frame = stack?.callFrames?.[0];
    if (frame)
        return `${String(frame.url ?? "")}:${Number(frame.lineNumber ?? 0) + 1}`;
    return typeof value.type === "string" ? value.type : undefined;
}
//# sourceMappingURL=utils.js.map