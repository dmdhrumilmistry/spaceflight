// Keyboard / mouse input. Uses KeyboardEvent.code (layout independent).
export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.handlers = [];
    this.enabled = true;
    this.drag = null;
    this.onDrag = null;
    this.onZoom = null;
    const typing = (e) => {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      if (!this.enabled) {
        for (const h of this.handlers) h(e.code, e, true);
        return;
      }
      if (['Space', 'Tab', 'Backquote', 'F1'].includes(e.code)) e.preventDefault();
      if (!e.repeat) for (const h of this.handlers) h(e.code, e, false);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag = { x: e.clientX, y: e.clientY };
      if (this.onDrag) this.onDrag(dx, dy);
    });
    const end = () => (this.drag = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.onZoom) this.onZoom(e.deltaY);
      },
      { passive: false },
    );
  }

  onKey(fn) {
    this.handlers.push(fn);
  }

  down(code) {
    return this.enabled && this.keys.has(code);
  }

  axis(neg, pos) {
    return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0);
  }
}
