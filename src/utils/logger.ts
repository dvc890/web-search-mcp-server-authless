
export const Logger = {
    isHTTP: true, // Always true for Workers
    log: (...args: any[]) => {
        console.log("[INFO]", ...args);
    },
    error: (...args: any[]) => {
        console.error("[ERROR]", ...args);
    },
};

export function writeLogs(name: string, value: any): void {
    // No-op in Cloudflare Workers (no filesystem)
    // Maybe in the future we can use R2 or something, but for now just console log if needed
    // Logger.log(`Debug log ${name}:`, value);
}
