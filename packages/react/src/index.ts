import { connect, type ClientSession, type ClientTool, type ConnectOptions } from '@vrealtime/client';
import type { TurnStateWire } from '@vrealtime/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface TranscriptLine {
  itemId: string;
  role: 'user' | 'agent';
  text: string;
  final: boolean;
}

export interface UseRealtimeOptions extends Omit<ConnectOptions, 'tools'> {
  /** App-side tools. Read through a ref: new closures on re-render are used without reconnecting. */
  tools?: Record<string, ClientTool>;
  /** Connect on mount (text-only apps). With audio, call `connect()` from a click instead. */
  autoConnect?: boolean;
}

export interface UseRealtime {
  status: RealtimeStatus;
  /** The agent's turn state. */
  state: TurnStateWire;
  transcript: TranscriptLine[];
  error: { code: string; message: string } | undefined;
  /** Idempotent; never rejects (failures land in `status` / `error`). Call it from a user gesture when using audio. */
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  interrupt: (reason?: 'user' | 'keyboard') => void;
  sendText: (text: string) => void;
  session: ClientSession | undefined;
}

function upsert(lines: TranscriptLine[], line: TranscriptLine, append = false): TranscriptLine[] {
  const index = lines.findIndex((l) => l.itemId === line.itemId);
  if (index === -1) return [...lines, line];
  const next = lines.slice();
  next[index] = append ? { ...line, text: lines[index]!.text + line.text } : line;
  return next;
}

/** React binding for `@vrealtime/client`; the session closes on unmount. */
export function useRealtime(url: string, options: UseRealtimeOptions = {}): UseRealtime {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [state, setState] = useState<TurnStateWire>('idle');
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState<UseRealtime['error']>(undefined);
  const [session, setSession] = useState<ClientSession | undefined>(undefined);
  const sessionRef = useRef<ClientSession | undefined>(undefined);
  const pendingRef = useRef<Promise<void> | undefined>(undefined);
  const mountedRef = useRef(false);
  const localCount = useRef(0);

  const connectNow = useCallback((): Promise<void> => {
    if (pendingRef.current) return pendingRef.current;
    const { tools = {}, autoConnect: _autoConnect, ...rest } = optionsRef.current;
    const delegated: Record<string, ClientTool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      delegated[name] = {
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.parameters,
        run: (args, context) => {
          const current = optionsRef.current.tools?.[name];
          if (!current) throw new Error(`Tool ${name} is no longer available`);
          return current.run(args, context);
        },
      };
    }
    setStatus('connecting');
    setError(undefined);
    const pending = connect(url, { ...rest, tools: delegated }).then(
      (connected) => {
        if (!mountedRef.current) {
          void connected.close();
          return;
        }
        sessionRef.current = connected;
        setSession(connected);
        setStatus('connected');
        connected.on('state', (e) => setState(e.state));
        connected.on('transcript', (e) => setTranscript((lines) => upsert(lines, { itemId: e.itemId, role: e.role, text: e.text, final: e.final })));
        connected.on('text', (e) => setTranscript((lines) => upsert(lines, { itemId: e.responseId, role: 'agent', text: e.delta, final: false }, true)));
        connected.on('error', (e) => setError({ code: e.code, message: e.message }));
        connected.on('reconnecting', () => setStatus('reconnecting'));
        connected.on('ready', () => setStatus('connected'));
        connected.on('closed', () => {
          if (sessionRef.current !== connected) return;
          sessionRef.current = undefined;
          pendingRef.current = undefined;
          setSession(undefined);
          setStatus('closed');
        });
      },
      (reason: unknown) => {
        pendingRef.current = undefined;
        if (!mountedRef.current) return;
        setStatus('error');
        setError({ code: 'CONNECT_FAILED', message: reason instanceof Error ? reason.message : String(reason) });
      },
    );
    pendingRef.current = pending;
    return pending;
  }, [url]);

  const disconnect = useCallback(async () => {
    const current = sessionRef.current;
    sessionRef.current = undefined;
    pendingRef.current = undefined;
    setSession(undefined);
    setStatus('closed');
    await current?.close();
  }, []);

  const interrupt = useCallback((reason: 'user' | 'keyboard' = 'user') => sessionRef.current?.interrupt(reason), []);

  const sendText = useCallback((text: string) => {
    const current = sessionRef.current;
    if (!current) return;
    // Typed text has no server transcript; show it locally.
    setTranscript((lines) => [...lines, { itemId: `local-${++localCount.current}`, role: 'user', text, final: true }]);
    current.sendText(text);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (optionsRef.current.autoConnect) void connectNow();
    return () => {
      mountedRef.current = false;
      const current = sessionRef.current;
      sessionRef.current = undefined;
      pendingRef.current = undefined;
      void current?.close();
    };
  }, [connectNow]);

  return { status, state, transcript, error, connect: connectNow, disconnect, interrupt, sendText, session };
}
