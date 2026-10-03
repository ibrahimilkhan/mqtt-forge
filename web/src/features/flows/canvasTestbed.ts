import { vi } from 'vitest';
import type { FlowRunStatusDto } from '../../types/api';
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

/**
 * A ResizeObserver that reports as a browser does: once, for every element handed to it in one go,
 * after they are laid out — where standInForTheBrowser's reports each one the moment it is handed
 * over. React Flow fits its first view to the nodes it has measured when it first hears of any, so
 * told of them one at a time it fits the view to the first node alone. For the cases about that view;
 * stub it in with `vi.stubGlobal('ResizeObserver', MeasuredTogether)` before the canvas is drawn.
 */
export class MeasuredTogether {
  private readonly callback: ResizeObserverCallback;
  private waiting: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.waiting.push(target);
    if (this.waiting.length > 1) return;

    queueMicrotask(() =>
      this.callback(
        this.waiting.splice(0).map((one) => {
          const { offsetWidth: width, offsetHeight: height } = one as HTMLElement;
          const contentRect = { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height } as DOMRectReadOnly;
          return { target: one, contentRect } as ResizeObserverEntry;
        }),
        this as unknown as ResizeObserver,
      ),
    );
  }

  unobserve() {}

  disconnect() {}
}

/**
 * Gives the canvas's pane a size, as a browser lays it out: under standInForTheBrowser it is a hundred
 * pixels square, read off the 100% it is styled with, and a view a hundred pixels across shows less
 * than one node. Returns what puts the stand-in back.
 */
export function paneSized(width: number, height: number) {
  const was = {
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!,
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!,
  };
  const pane = (element: HTMLElement) => element.classList.contains('react-flow__renderer');

  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return pane(this) ? width : was.offsetWidth.get!.call(this);
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return pane(this) ? height : was.offsetHeight.get!.call(this);
      },
    },
  });

  return () => Object.defineProperties(HTMLElement.prototype, was);
}

/** How far the canvas is panned and how far it is zoomed, read off the transform it draws with. */
export function viewport(): [number, number, number] {
  const transform = document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform;
  const [, x, y, zoom] = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform)!;
  return [Number(x), Number(y), Number(zoom)];
}

/** No drafts, nothing refused, nothing picked: the draft store as a page that has never been opened finds it. */
export function forgetDrafts(current: string | null = null) {
  useFlowDraftStore.setState({
    drafts: {},
    bases: {},
    current,
    selected: null,
    wire: null,
    refusals: {},
    refusedCopies: {},
    unkept: false,
  });
}

/**
 * One run of a flow as a status push reports it: the flow at work, waiting, with nothing yet to say
 * about where or why, unless `over` says otherwise. Every test that pushes numbers builds its runs
 * here, so a field the server adds to a run is added once.
 */
export const runOf = (flowId: string, over: Partial<FlowRunStatusDto> = {}): FlowRunStatusDto => ({
  flowId,
  kind: 'active',
  state: 'waiting',
  at: null,
  waiting: null,
  fault: null,
  variables: {},
  nodes: [],
  ...over,
});

/** A stylesheet with its comments left out, so a test reads only what it declares. */
export const withoutComments = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, '');
