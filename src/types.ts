export interface User {
  id: string;
  sub: string;
  issuer: string;
  email?: string;
  name?: string;
  createdAt: number;
  lastLoginAt: number;
}

export interface Tunnel {
  id: string;
  name: string;
  description: string;
  /** Bearer token consumers use for the REST/WebSocket API. */
  token: string;
  enabled: boolean;
  /** HTTP status returned to the webhook sender. */
  responseStatus: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface EventMeta {
  id: string;
  tunnelId: string;
  receivedAt: number;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  contentType: string;
  size: number;
  ip: string;
  ackedAt: number | null;
  chunks: number;
}

export interface EventView extends Omit<EventMeta, "chunks"> {
  body?: string;
  bodyEncoding?: "utf8" | "base64";
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  tunnelId?: string;
  userId?: string;
  data?: Record<string, unknown>;
}

export const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
