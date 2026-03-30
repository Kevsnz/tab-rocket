export function formatLocalTime(timestamp: number | null): string {
    if (timestamp === null) {
        return 'later';
    }

    return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    });
}
