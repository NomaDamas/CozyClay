// Observe rendered state on the browser's frame signal, never after an assumed
// number of milliseconds. The timeout is only a failure bound, not a delay.
export const waitForFrameState = (evaluate, expression, timeoutMs = 15000) => evaluate(`new Promise((resolve, reject) => {
  let frame;
  const finish = value => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(value); };
  const timer = setTimeout(() => finish(false), ${timeoutMs});
  const observe = () => {
    try { if (${expression}) return finish(true); }
    catch (error) { clearTimeout(timer); cancelAnimationFrame(frame); reject(error); return; }
    frame = requestAnimationFrame(observe);
  };
  observe();
})`);
