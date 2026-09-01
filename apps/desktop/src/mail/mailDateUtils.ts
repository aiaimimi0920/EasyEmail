import { parseVisibleMailMessageDate } from "./mailSelectors.ts";

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatMailListTime(value: string, now = new Date()): string {
  const date = parseVisibleMailMessageDate(value);
  if (!date) {
    return value;
  }

  const time = `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const messageDayStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const dayDiff = Math.round((todayStart - messageDayStart) / 86_400_000);

  if (dayDiff === 0) {
    return time;
  }
  if (dayDiff === 1) {
    return `昨天 ${time}`;
  }
  if (dayDiff === 2) {
    return `前天 ${time}`;
  }
  return `${date.getFullYear()}/${padDatePart(date.getMonth() + 1)}/${padDatePart(
    date.getDate(),
  )}`;
}
