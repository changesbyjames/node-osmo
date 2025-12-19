export interface StoreSnapshot<TContext> {
  context: TContext;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface Store<TContext, TEvent extends { type: string }> {
  getSnapshot(): StoreSnapshot<TContext>;
  send(event: TEvent): void;
  subscribe(listener: (snapshot: StoreSnapshot<TContext>) => void): Subscription;
}

export type StoreAssigner<TContext, TEvent extends { type: string }> = (
  context: TContext,
  event: TEvent,
) => TContext | void;

export interface StoreConfig<TContext, TEvent extends { type: string }> {
  context: TContext;
  on: Record<string, StoreAssigner<TContext, TEvent>>;
}

export function createStore<TContext, TEvent extends { type: string }>(
  config: StoreConfig<TContext, TEvent>,
): Store<TContext, TEvent> {
  let context = config.context;
  const listeners = new Set<(snapshot: StoreSnapshot<TContext>) => void>();

  const getSnapshot = (): StoreSnapshot<TContext> => ({ context });

  const send = (event: TEvent): void => {
    const assigner = config.on[event.type];
    if (!assigner) return;
    const next = assigner(context, event);
    if (next !== undefined) {
      context = next;
      const snapshot = getSnapshot();
      for (const l of listeners) l(snapshot);
    }
  };

  const subscribe = (listener: (snapshot: StoreSnapshot<TContext>) => void): Subscription => {
    listeners.add(listener);
    return { unsubscribe: () => listeners.delete(listener) };
  };

  return { getSnapshot, send, subscribe };
}

