import { vi } from 'vitest';
import { useFlowDraftStore } from './flowDraftStore';

/**
 * What React Flow needs from a browser that jsdom does not have: something to measure elements
 * with, and a matrix to read the zoom out of, much as React Flow's own testing guide gives them;
 * and, for the canvas's own work, a drag event that says where it was let go and an answer to
 * "what is under the pointer". Call it in a beforeAll of a test file that draws the canvas;
 * `vi.unstubAllGlobals()` in an afterAll takes the three globals back, and what is set on the
 * prototypes lasts only as long as the test file, which runs in a window of its own.
 */
export function standInForTheBrowser() {
  class Observer {
    readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    // The entry carries a content box as well as its target: the pane caches its own extent from
    // `contentRect`, and reads it straight off the entry. It is the size the two stand-ins below
    // say the element has, so the observer and the element agree about it.
    observe(target: Element) {
      const { offsetWidth: width, offsetHeight: height } = target as HTMLElement;
      const contentRect = { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height } as DOMRectReadOnly;
      this.callback([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }

    unobserve() {}

    disconnect() {}
  }

  class Matrix {
    readonly m22: number;

    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
      this.m22 = scale === undefined ? 1 : Number(scale);
    }
  }

  // jsdom has no DragEvent, and Testing Library falls back to a bare Event for a drop, which has
  // no clientX or clientY: a node dropped on the canvas would land at NaN, NaN. A drag event is a
  // mouse event that carries what is being dragged, so that is what this is.
  class Drag extends MouseEvent {
    readonly dataTransfer: DataTransfer | null;

    constructor(type: string, init: DragEventInit = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }

  vi.stubGlobal('ResizeObserver', Observer);
  vi.stubGlobal('DOMMatrixReadOnly', Matrix);
  vi.stubGlobal('DragEvent', Drag);

  // React Flow asks what is under the pointer before it lands a wire, and prefers a port found
  // there to the one the wire was aimed at. jsdom lays nothing out, so the true answer is nothing,
  // and React Flow goes by the port it was given.
  Document.prototype.elementFromPoint = () => null;

  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get() {
        return Number.parseFloat((this as HTMLElement).style.height) || 1;
      },
    },
    offsetWidth: {
      configurable: true,
      get() {
        return Number.parseFloat((this as HTMLElement).style.width) || 1;
      },
    },
  });

  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}

/** No drafts, nothing refused, nothing picked: the draft store as a page that has never been opened finds it. */
export function forgetDrafts(current: string | null = null) {
  useFlowDraftStore.setState({ drafts: {}, bases: {}, current, selected: null, refusals: {}, unkept: false });
}

/** A stylesheet with its comments left out, so a test reads only what it declares. */
export const withoutComments = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, '');
