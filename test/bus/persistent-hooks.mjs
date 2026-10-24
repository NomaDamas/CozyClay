// Minimal persistent hook runtime: renders a hook function repeatedly while keeping useRef/useState/useMemo slots,
// and runs useEffect after each render (deps-compared) like React does. Needed because renderToStaticMarkup
// remounts (fresh refs) on every call, which hides cross-render bugs.
import React from 'react';
const I = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
export function persistentRender(fn) {
  const slots = []; let idx = 0, effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
  const d = {
    useRef: init => { const i = idx++; return (slots[i] ??= { current: init }); },
    useState: init => { const i = idx++; const s = (slots[i] ??= { v: typeof init === 'function' ? init() : init }); return [s.v, (s.set ??= u => { s.v = typeof u === 'function' ? u(s.v) : u; })]; },
    useMemo: (f, deps) => { const i = idx++; const s = (slots[i] ??= {}); if (!s.has || changed(s.deps, deps)) { s.val = f(); s.deps = deps; s.has = true; } return s.val; },
    useCallback: (f, deps) => d.useMemo(() => f, deps),
    useEffect: (f, deps) => { const i = idx++; const s = (slots[i] ??= {}); if (deps === undefined || changed(s.deps, deps)) { s.deps = deps; effects.push(() => { s.cleanup?.(); s.cleanup = f(); }); } },
    useLayoutEffect: (f, deps) => d.useEffect(f, deps),
    useSyncExternalStore: (_sub, get) => get(),
    useContext: c => c._currentValue,
    useReducer: (r, init) => d.useState(init),
    useId: () => 'id', useDebugValue() {}, useTransition: () => [false, f => f()], useDeferredValue: v => v,
  };
  let result;
  return function render() {
    const prev = I.H; I.H = d; idx = 0; effects = [];
    try { result = fn(); } finally { I.H = prev; }
    const run = effects; effects = []; for (const e of run) e();
    return result;
  };
}
