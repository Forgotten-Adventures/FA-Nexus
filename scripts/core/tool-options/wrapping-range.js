// Opt-in cyclic input for scalar angles. Keep the native range element and its
// input/change contract, but calculate values before the browser clamps them.
export function bindWrappingRange(input) {
  let drag = null;
  const limits = () => ({min:Number(input.min), max:Number(input.max), step:Number(input.step) || 1});
  const stop = event => { event.preventDefault(); event.stopPropagation(); };
  const write = value => {
    const {min,max,step} = limits();
    const count = Math.round((max-min)/step)+1;
    const index = Math.round((value-min)/step);
    const next = min + (((index%count)+count)%count)*step;
    if (Number(input.value) === next) return;
    input.value = String(next);
    input.dispatchEvent(new Event('input',{bubbles:true}));
  };
  const commit = () => input.dispatchEvent(new Event('change',{bubbles:true}));
  const down = event => {
    if (input.disabled || event.button !== 0 || drag) return;
    const rect = input.getBoundingClientRect(), {min,max} = limits();
    if (rect.width <= 0 || max <= min) return;
    stop(event);
    input.focus({preventScroll:true});
    // Foundry v14's native range thumb is 12px wide.
    const width = Math.max(1,rect.width-12), left = rect.left+6;
    const current = Number(input.value);
    const thumb = left + (current-min)/(max-min)*width;
    if (Math.abs(event.clientX-thumb)>6) write(Math.min(max,Math.max(min,min+(event.clientX-left)/width*(max-min))));
    drag = {id:event.pointerId, x:event.clientX, value:Number(input.value), units:(max-min)/width};
    input.setPointerCapture(event.pointerId);
  };
  const move = event => {
    if (!drag || event.pointerId !== drag.id) return;
    stop(event);
    write(drag.value+(event.clientX-drag.x)*drag.units);
  };
  const release = () => {
    const held = drag;
    drag = null;
    if (held && input.hasPointerCapture(held.id)) input.releasePointerCapture(held.id);
    return !!held;
  };
  const up = event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (event.type === 'pointerup') move(event);
    release();
    commit();
  };
  const keydown = event => {
    if (input.disabled) return;
    const {min,max,step} = limits();
    const delta = {ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-10,PageUp:10}[event.key];
    if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
    stop(event);
    write(event.key === 'Home' ? min : event.key === 'End' ? max : Number(input.value)+delta*step);
    commit();
  };
  const wheel = event => {
    if (input.disabled || !event.ctrlKey) return;
    const delta = Number(event.deltaY) || Number(event.deltaX);
    if (!delta) return;
    stop(event);
    write(Number(input.value)+(delta<0 ? 1 : -1)*limits().step);
    commit();
  };
  const listeners = {pointerdown:down,pointermove:move,pointerup:up,pointercancel:up,lostpointercapture:up,keydown,wheel};
  for (const [name,handler] of Object.entries(listeners)) input.addEventListener(name,handler,{passive:false});
  return () => {
    release();
    for (const [name,handler] of Object.entries(listeners)) input.removeEventListener(name,handler);
  };
}
