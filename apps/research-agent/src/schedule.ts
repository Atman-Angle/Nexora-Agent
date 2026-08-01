export type DailySchedule = {
  readonly cron: string;
  readonly timezone: string;
};

export type DailyScheduleState = {
  readonly businessDate: string;
  readonly scheduledLocalTime: string;
  readonly due: boolean;
};

export function validateDailySchedule(schedule: DailySchedule): void {
  parseDailyCron(schedule.cron);
  zonedDateTimeParts(new Date(), schedule.timezone);
}

export function getDailyScheduleState(
  schedule: DailySchedule,
  now: Date
): DailyScheduleState {
  if (Number.isNaN(now.getTime())) throw new Error("Scheduler now must be a valid Date.");
  const { minute, hour } = parseDailyCron(schedule.cron);
  const local = zonedDateTimeParts(now, schedule.timezone);
  return {
    businessDate: `${local.year}-${local.month}-${local.day}`,
    scheduledLocalTime: `${pad(hour)}:${pad(minute)}[${schedule.timezone}]`,
    due: local.hour > hour || (local.hour === hour && local.minute >= minute)
  };
}

function parseDailyCron(value: string): { readonly minute: number; readonly hour: number } {
  const fields = value.trim().split(/\s+/u);
  if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*" || fields[4] !== "*") {
    throw new Error("Research Agent schedule must be a daily cron in the form '<minute> <hour> * * *'.");
  }
  const minute = parseInteger(fields[0], 0, 59, "minute");
  const hour = parseInteger(fields[1], 0, 23, "hour");
  return { minute, hour };
}

function parseInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`Research Agent daily cron ${label} must be an integer.`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`Research Agent daily cron ${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function zonedDateTimeParts(now: Date, timezone: string): {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: number;
  readonly minute: number;
} {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
  } catch {
    throw new Error(`Research Agent schedule timezone is invalid: ${timezone}.`);
  }
  const values = new Map(
    formatter.formatToParts(now).map((part) => [part.type, part.value])
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = Number(values.get("hour"));
  const minute = Number(values.get("minute"));
  if (year === undefined || month === undefined || day === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Research Agent could not resolve local time for timezone: ${timezone}.`);
  }
  return { year, month, day, hour, minute };
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
