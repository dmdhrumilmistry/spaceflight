// Keyboard / mouse input. Uses KeyboardEvent.code (layout independent).
export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.handlers = [];
    this.enabled = true;
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
    // one pointer drags the camera, two pointers pinch-zoom (touch screens)
    const pts = new Map();
    let pinch = 0;
    canvas.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (pts.size === 1) {
        if (this.onDrag) this.onDrag(cur.x - prev.x, cur.y - prev.y);
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && this.onZoom) this.onZoom((pinch - d) * 4);
        pinch = d;
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      pinch = 0;
    };
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
