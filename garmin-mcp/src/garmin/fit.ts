/**
 * Activity file decoding. Garmin's download endpoint returns a ZIP archive with
 * the original file, usually a single FIT file. Decoding uses Garmin's official
 * FIT JavaScript SDK.
 */
import { Decoder, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";

const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;
/** Gaps between records longer than this are pauses and don't count towards split times. */
const MAX_RECORD_GAP_S = 30;

export interface FitDecodeOptions {
  /** Include the record timeline, evenly downsampled to at most `maxRecords` points. */
  includeRecords: boolean;
  maxRecords: number;
  /** Length of the computed distance splits, in metres. */
  splitDistance: number;
}

export interface DecodedFitFile {
  fileName: string;
  errors?: string[];
  fileId?: unknown;
  activity?: unknown;
  sessions?: unknown[];
  laps?: unknown[];
  distanceSplits?: DistanceSplit[];
  splits?: unknown[];
  splitSummaries?: unknown[];
  timeInZone?: unknown[];
  devices?: unknown[];
  events?: unknown[];
  recordCount: number;
  records?: RecordTable;
}

export interface DistanceSplit {
  split: number;
  distanceMeters: number;
  seconds: number;
  pacePerKm: string;
  avgHeartRate?: number;
  ascentMeters?: number;
}

/** Records as columns + rows: a fraction of the size of one object per record. */
export interface RecordTable {
  columns: string[];
  rows: unknown[][];
}

type Message = Record<string, unknown>;

export function unzipActivity(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  // Some activities are served as a bare FIT file rather than a ZIP archive.
  if (!isZip(bytes)) return [{ name: "activity.fit", data: bytes }];
  return Object.entries(unzipSync(bytes)).map(([name, data]) => ({ name, data }));
}

export function decodeFit(fileName: string, data: Uint8Array, options: FitDecodeOptions): DecodedFitFile {
  const stream = Stream.fromByteArray(data);
  if (!Decoder.isFIT(stream)) {
    return { fileName, errors: ["Not a FIT file; only FIT activity files can be decoded."], recordCount: 0 };
  }

  const { messages, errors } = new Decoder(stream).read({ includeUnknownData: false });
  const all = <T extends object>(list: T[] | undefined) => list?.map((message) => withDegrees(message as Message));
  const records = (all(messages.recordMesgs) ?? []) as Message[];

  return {
    fileName,
    ...(errors.length > 0 && { errors: errors.map((error) => error.message) }),
    fileId: messages.fileIdMesgs?.[0],
    activity: messages.activityMesgs?.[0],
    sessions: all(messages.sessionMesgs),
    laps: all(messages.lapMesgs),
    distanceSplits: distanceSplits(records, options.splitDistance),
    splits: all(messages.splitMesgs),
    splitSummaries: all(messages.splitSummaryMesgs),
    timeInZone: messages.timeInZoneMesgs,
    devices: uniqueDevices(messages.deviceInfoMesgs ?? []),
    events: messages.eventMesgs?.filter((event) => event.event !== "timer" || event.eventType !== "start"),
    recordCount: records.length,
    ...(options.includeRecords && { records: recordTable(downsample(records, options.maxRecords)) }),
  };
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** FIT stores coordinates as semicircles; convert every `*Lat` / `*Long` field to degrees. */
function withDegrees(message: Message): Message {
  const converted: Message = {};
  for (const [key, value] of Object.entries(message)) {
    converted[key] = typeof value === "number" && /(Lat|Long)$/.test(key) ? value * SEMICIRCLES_TO_DEGREES : value;
  }
  return converted;
}

/** Devices are logged repeatedly during an activity; keep one merged entry per device. */
function uniqueDevices(devices: readonly object[]): unknown[] {
  const seen = new Map<string, Message>();
  for (const { timestamp: _timestamp, ...device } of devices as Message[]) {
    const key = String(device.deviceIndex ?? device.serialNumber ?? seen.size);
    seen.set(key, { ...seen.get(key), ...device });
  }
  return [...seen.values()];
}

const seconds = (value: unknown) => (value instanceof Date ? value.getTime() / 1000 : undefined);
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

/** The record fields worth a timeline, in column order. */
const RECORD_COLUMNS: Array<[string, (record: Message, start: number) => unknown]> = [
  ["elapsedSeconds", (record, start) => Math.round((seconds(record.timestamp) ?? start) - start)],
  ["distance", (record) => record.distance],
  ["speed", (record) => record.enhancedSpeed ?? record.speed],
  ["heartRate", (record) => record.heartRate],
  ["cadence", (record) => record.cadence],
  ["power", (record) => record.power],
  ["altitude", (record) => record.enhancedAltitude ?? record.altitude],
  ["lat", (record) => record.positionLat],
  ["lon", (record) => record.positionLong],
  ["temperature", (record) => record.temperature],
];

function recordTable(records: Message[]): RecordTable {
  const start = seconds(records[0]?.timestamp) ?? 0;
  const values = RECORD_COLUMNS.map(([, read]) => records.map((record) => read(record, start) ?? null));
  // Keep only the columns this activity actually recorded.
  const used = RECORD_COLUMNS.map((_, index) => index).filter((index) => values[index]!.some((value) => value !== null));
  return {
    columns: used.map((index) => RECORD_COLUMNS[index]![0]),
    rows: records.map((_, row) => used.map((index) => values[index]![row])),
  };
}

/**
 * Splits of `splitMeters` computed from the full-resolution records, like the
 * per-kilometre splits in Garmin Connect. Time is interpolated at each
 * boundary; gaps longer than MAX_RECORD_GAP_S (pauses) are left out.
 */
export function distanceSplits(records: Message[], splitMeters: number): DistanceSplit[] {
  const points: Array<{ t: number; d: number; hr?: number; alt?: number }> = [];
  for (const record of records) {
    const t = seconds(record.timestamp);
    const d = num(record.distance);
    if (t === undefined || d === undefined) continue;
    points.push({ t, d, hr: num(record.heartRate), alt: num(record.enhancedAltitude ?? record.altitude) });
  }

  const splits: DistanceSplit[] = [];
  let boundary = splitMeters;
  let acc = { seconds: 0, hrSeconds: 0, hrSum: 0, ascent: 0 };
  const add = (time: number, hr: number | undefined) => {
    acc.seconds += time;
    if (hr !== undefined) {
      acc.hrSum += hr * time;
      acc.hrSeconds += time;
    }
  };
  const close = (distance: number) => {
    if (distance <= 0 || acc.seconds <= 0) return;
    splits.push({
      split: splits.length + 1,
      distanceMeters: Math.round(distance),
      seconds: Math.round(acc.seconds),
      pacePerKm: formatPace((acc.seconds / distance) * 1000),
      ...(acc.hrSeconds > 0 && { avgHeartRate: Math.round(acc.hrSum / acc.hrSeconds) }),
      ...(acc.ascent > 0 && { ascentMeters: Math.round(acc.ascent) }),
    });
    acc = { seconds: 0, hrSeconds: 0, hrSum: 0, ascent: 0 };
  };

  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dt = b.t - a.t;
    const counted = dt > 0 && dt <= MAX_RECORD_GAP_S ? dt : 0;
    const dd = b.d - a.d;
    const hr = b.hr ?? a.hr;
    if (a.alt !== undefined && b.alt !== undefined && b.alt > a.alt) acc.ascent += b.alt - a.alt;
    let from = a.d;
    while (dd > 0 && b.d >= boundary) {
      add((counted * (boundary - from)) / dd, hr);
      close(splitMeters);
      from = boundary;
      boundary += splitMeters;
    }
    add(dd > 0 ? (counted * (b.d - from)) / dd : counted, hr);
  }
  const last = points.at(-1);
  if (last) close(last.d - (boundary - splitMeters));
  return splits;
}

function formatPace(secondsPerKm: number): string {
  const rounded = Math.round(secondsPerKm);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

/** Evenly spaced sample that always keeps the first and last items. */
export function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return items.slice(0, max);
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => items[Math.round(index * step)] as T);
}
