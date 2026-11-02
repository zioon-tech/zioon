const MINUTE = 60_000;

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return "请选择运行时间";
  if (schedule.kind === "interval") {
    const minutes = Number(schedule.intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) return "间隔必须在 1 分钟到 7 天之间";
    return "";
  }
  if (schedule.kind === "daily" || schedule.kind === "weekdays") {
    return parseTime(schedule.time) ? "" : "时间格式必须为 HH:mm";
  }
  if (schedule.kind === "once") {
    const timestamp = Number(schedule.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return "单次运行时间必须晚于当前时间";
    return "";
  }
  return "不支持的调度类型";
}

export function computeNextRun(schedule, from = Date.now()) {
  if (schedule?.kind === "interval") {
    return from + Number(schedule.intervalMinutes) * MINUTE;
  }
  if (schedule?.kind === "once") {
    const timestamp = Number(schedule.timestamp);
    return timestamp > from ? timestamp : null;
  }

  const parsed = parseTime(schedule?.time);
  if (!parsed) return null;
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setHours(parsed.hour, parsed.minute, 0, 0);
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);

  if (schedule.kind === "weekdays") {
    while (candidate.getDay() === 0 || candidate.getDay() === 6) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  return candidate.getTime();
}

export function describeSchedule(schedule) {
  if (schedule?.kind === "interval") return `每 ${schedule.intervalMinutes} 分钟`;
  if (schedule?.kind === "daily") return `每天 ${schedule.time}`;
  if (schedule?.kind === "weekdays") return `工作日 ${schedule.time}`;
  if (schedule?.kind === "once") return `单次 · ${new Date(Number(schedule.timestamp)).toLocaleString()}`;
  return "未设置";
}

export function normalizeSchedule(input = {}) {
  const kind = ["interval", "daily", "weekdays", "once"].includes(input.kind) ? input.kind : "daily";
  if (kind === "interval") return { kind, intervalMinutes: Math.max(1, Number(input.intervalMinutes) || 60) };
  if (kind === "once") return { kind, timestamp: Number(input.timestamp) || Date.now() + 60 * MINUTE };
  return { kind, time: parseTime(input.time) ? input.time : "09:00" };
}
