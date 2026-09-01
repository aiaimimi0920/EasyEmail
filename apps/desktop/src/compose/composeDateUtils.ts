function padComposeDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

export function defaultComposeCustomScheduleDate(now = new Date()): Date {
  const date = new Date(now);
  date.setHours(date.getHours() + 1);
  date.setSeconds(0, 0);
  return date;
}

export function formatComposeLocalDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${padComposeDatePart(date.getMonth() + 1)}-${padComposeDatePart(
    date.getDate(),
  )}T${padComposeDatePart(date.getHours())}:${padComposeDatePart(date.getMinutes())}`;
}

export function formatComposeScheduleDate(date: Date): string {
  return date.toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatComposeDraftSavedAt(value: string | null): string {
  if (!value) {
    return "未保存";
  }
  const savedAt = new Date(value);
  if (Number.isNaN(savedAt.getTime())) {
    return "未保存";
  }
  return `保存于 ${savedAt.toLocaleTimeString("zh-CN", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export function composeDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${padComposeDatePart(date.getMonth() + 1)}-${padComposeDatePart(
    date.getDate(),
  )}`;
}

export function defaultComposeExpirationDate(now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + 7);
  return composeDateInputValue(date);
}

export function positivePort(value: string, fallback = 993): number {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return fallback;
  }
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}
