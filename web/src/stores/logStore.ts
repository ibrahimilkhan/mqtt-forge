import { create } from 'zustand';
import type { MqttMessage } from '../types/api';

export const MAX_LOG_ENTRIES = 500;

type LogKind = 'recv' | 'sent' | 'ok' | 'fault';

// The unit of the wire log. 'recv' comes from the hub, the rest from command results.
export type LogEntry = {
  id: number;
  kind: LogKind;
  at: Date;
  verb: string;
  topic?: string;
  body?: string;
  stamps?: string[];
};

type NewLogEntry = Omit<LogEntry, 'id' | 'at'>;

type LogState = {
  entries: LogEntry[];
  push: (entry: NewLogEntry) => void;
  appendReceived: (messages: MqttMessage[]) => void;
  clear: () => void;
};

let nextId = 0;

export const useLogStore = create<LogState>((set) => ({
  entries: [],

  push: (entry) =>
    set((state) => ({ entries: cap([{ ...entry, id: nextId++, at: new Date() }, ...state.entries]) })),

  appendReceived: (messages) =>
    set((state) => ({ entries: cap([...messages.map(toEntry).reverse(), ...state.entries]) })),

  clear: () => set({ entries: [] }),
}));

function toEntry(message: MqttMessage): LogEntry {
  const stamps = [`QoS ${message.qos}`];
  if (message.retain) stamps.push('RETAINED');
  stamps.push(payloadSize(message.payload));

  return {
    id: nextId++,
    kind: 'recv',
    at: new Date(message.receivedAt),
    verb: 'Received',
    topic: message.topic,
    body: message.payload,
    stamps,
  };
}

// What went over the wire is bytes, so a payload of accented text is longer than it looks.
function payloadSize(payload: string): string {
  const bytes = new TextEncoder().encode(payload).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

// A '#' subscription on a busy broker would otherwise grow the list without bound.
const cap = (entries: LogEntry[]) =>
  entries.length > MAX_LOG_ENTRIES ? entries.slice(0, MAX_LOG_ENTRIES) : entries;
