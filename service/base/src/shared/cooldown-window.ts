export const UTC_RESET_WINDOW_HOURS = [0, 6, 12, 18] as const;

export function resolveUtcResetWindowKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = UTC_RESET_WINDOW_HOURS.reduce((current, value) => (value <= now.getUTCHours() ? value : current), 0);
  return `${year}-${month}-${day}T${String(hour).padStart(2, "0")}:00:00Z`;
}

export function resolveNextUtcResetAt(now: Date = new Date()): Date {
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);

  for (const hour of UTC_RESET_WINDOW_HOURS) {
    if (hour > now.getUTCHours()) {
      next.setUTCHours(hour, 0, 0, 0);
      return next;
    }
  }

  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}
