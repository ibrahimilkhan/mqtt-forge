import { describe, expect, it } from 'vitest';
import type { FlowDto, FlowNodeType } from '../../types/api';
import { MARGIN, pointsOf, routes, wayOf, type End } from './backWires';
import { exampleFlows } from './examples';
import { emptyFlow } from './flowDocument';
import { clicked, drawnAs, drawnBox, routedIn, wrongWith } from './wireTestbed';

/**
 * A flow of the nodes and wires given, as a reader might have left it: each node `id:type@x,y`, each
 * wire `from.port>to.port`.
 */
function drawing(nodes: string[], ...wires: string[]): FlowDto {
  return {
    id: 'f',
    name: 'Drawn',
    enabled: false,
    variables: [],
    nodes: nodes.map((text) => {
      const [, id, type, x, y] = /^(\w+):(\w+)@(-?\d+),(-?\d+)$/.exec(text)!;
      return { id, type: type as FlowNodeType, x: Number(x), y: Number(y), config: {} };
    }),
    edges: wires.map((text, at) => {
      const [from, fromPort, to, toPort] = text.split(/[.>]/);
      return { id: `w${at + 1}`, from, fromPort, to, toPort };
    }),
  };
}

/** The route of one wire of a flow, as the canvas would draw it. */
const routeOf = (flow: FlowDto, wire: string) => routedIn(flow).drawn.find((one) => one.leg.id === wire)?.route;

const end = (x: number, y: number, side: End['side']): End => ({ x, y, side });

describe('which way a wire goes', () => {
  it('climbs when its way in stands left of its way out and no lower', () => {
    expect(wayOf(end(800, 155, 'right'), end(418, 116, 'top'))).toBe('climbs');
    expect(wayOf(end(800, 155, 'right'), end(356, 155, 'left'))).toBe('climbs');
  });

  // Up over its own node and down again, a wire to a node under it and to its left crossed the row it
  // left twice: it goes down instead.
  it('goes down to a way in further left that stands lower than its way out', () => {
    expect(wayOf(end(418, 195, 'bottom'), end(320, 335, 'left'))).toBe('descends');
  });

  it('rises from a foot to a way in to its right that stands no lower than the foot', () => {
    expect(wayOf(end(418, 195, 'bottom'), end(640, 155, 'left'))).toBe('rises');
    expect(wayOf(end(418, 195, 'bottom'), end(476, 331, 'left'))).toBe('forward');
    expect(wayOf(end(516, 155, 'right'), end(604, 155, 'left'))).toBe('forward');
  });
});

/**
 * The drawings the review found wanting. Clicked together, the palette used to step a node down a
 * row when the place beside the node it followed was taken — the End of a new flow stood there — so
 * the chain's last wire went back up to the End, and the canvas drew it through the End, or on the
 * same line as another wire. Here as the palette left them, and as readers draw them.
 */
describe('a wire drawn round, in the drawings the review found wanting', () => {
  const left = {
    'MQTT in where the palette put it, under the End': drawing(
      ['start:start@40,120', 'end:end@360,120', 'read:mqttIn@276,224'],
      'start.out>read.in',
      'read.out>end.in',
    ),
    'a For where the palette put it, under the End: its empty body and its done both back': drawing(
      ['start:start@40,120', 'end:end@360,120', 'loop:for@276,224'],
      'start.out>loop.in',
      'loop.body>loop.next',
      'loop.done>end.in',
    ),
    'a For put on a new flow’s wire, half-way along it, under the End': drawing(
      ['start:start@40,120', 'end:end@360,120', 'loop:for@200,224'],
      'start.out>loop.in',
      'loop.body>loop.next',
      'loop.done>end.in',
    ),
    'an If under the End, its yes and its no both back to it': drawing(
      ['start:start@40,120', 'end:end@360,120', 'test:if@276,244'],
      'start.out>test.in',
      'test.yes>end.in',
      'test.no>end.in',
    ),
    'a For’s done to an End straight under it': drawing(
      ['start:start@40,120', 'loop:for@324,120', 'say:debug@608,120', 'end:end@324,300'],
      'start.out>loop.in',
      'loop.body>say.in',
      'say.out>loop.next',
      'loop.done>end.in',
    ),
    'two loops on one row, one inside the other': drawing(
      [
        'start:start@40,120',
        'loop:for@324,120',
        'each:forEach@608,120',
        'send:publish@892,120',
        'tick:wait@764,296',
        'end:end@480,296',
      ],
      'start.out>loop.in',
      'loop.body>each.in',
      'each.body>send.in',
      'send.out>each.next',
      'each.done>tick.in',
      'tick.out>loop.next',
      'loop.done>end.in',
    ),
    'a body left of its loop': drawing(
      ['start:start@40,320', 'say:debug@200,120', 'loop:for@600,120', 'end:end@884,320'],
      'start.out>loop.in',
      'loop.body>say.in',
      'say.out>loop.next',
      'loop.done>end.in',
    ),
    'a body straight under its loop': drawing(
      ['start:start@40,120', 'loop:for@324,120', 'say:debug@324,296', 'end:end@700,296'],
      'start.out>loop.in',
      'loop.body>say.in',
      'say.out>loop.next',
      'loop.done>end.in',
    ),
    'an empty body alone': drawing(
      ['start:start@40,120', 'loop:for@324,120', 'end:end@480,296'],
      'start.out>loop.in',
      'loop.body>loop.next',
      'loop.done>end.in',
    ),
    'the watch with its Clear alarm under the If’s no': {
      ...exampleFlows()[1],
      nodes: exampleFlows()[1].nodes.map((node) => (node.id === 'cool' ? { ...node, x: 1208, y: 296 } : node)),
    },
  };

  const fresh = () => ({ ...emptyFlow('Flow 1'), id: 'f1' });
  const wireOf = (flow: FlowDto, from: string, port: string) => flow.edges.find((edge) => edge.from === from && edge.fromPort === port)!.id;
  const clickedTogether = {
    'a new flow, the Start picked, MQTT in clicked': clicked(fresh(), { node: 'start' }, 'mqttIn', 'read'),
    'a new flow, the Start picked, For clicked': clicked(fresh(), { node: 'start' }, 'for', 'loop'),
    'a new flow, its wire picked, For clicked': (() => {
      const flow = fresh();
      return clicked(flow, { wire: flow.edges[0].id }, 'for', 'loop');
    })(),
    'a new flow, the Start picked, If clicked: its yes and its no to the End': clicked(fresh(), { node: 'start' }, 'if', 'test'),
    'a For clicked after the Start, then Debug on its empty body': (() => {
      const flow = clicked(fresh(), { node: 'start' }, 'for', 'loop');
      return clicked(flow, { wire: wireOf(flow, 'loop', 'body') }, 'debug', 'say');
    })(),
    'MQTT in, Debug and If clicked after the Start, then Publish on the If’s yes': (() => {
      let flow = clicked(fresh(), { node: 'start' }, 'mqttIn', 'read');
      flow = clicked(flow, { node: 'read' }, 'debug', 'say');
      flow = clicked(flow, { node: 'say' }, 'if', 'test');
      return clicked(flow, { wire: wireOf(flow, 'test', 'yes') }, 'publish', 'send');
    })(),
    'a For after the Start, MQTT in, Debug and If on its body, Publish on the If’s yes': (() => {
      let flow = clicked(fresh(), { node: 'start' }, 'for', 'loop');
      flow = clicked(flow, { wire: wireOf(flow, 'loop', 'body') }, 'mqttIn', 'read');
      flow = clicked(flow, { node: 'read' }, 'debug', 'say');
      flow = clicked(flow, { node: 'say' }, 'if', 'test');
      return clicked(flow, { wire: wireOf(flow, 'test', 'yes') }, 'publish', 'send');
    })(),
    'the watch, its Debug picked, Publish clicked': clicked({ ...exampleFlows()[1] }, { node: 'say' }, 'publish', 'send'),
    'the watch, its For’s done picked, Debug clicked': (() => {
      const watch = exampleFlows()[1];
      return clicked(watch, { wire: wireOf(watch, 'loop', 'done') }, 'debug', 'note');
    })(),
  };

  it.each(Object.entries({ ...left, ...clickedTogether }))(
    '%s: runs through no node and no name, and on no other wire but into the port they share',
    (_, flow) => {
      expect(wrongWith(flow)).toEqual([]);
    },
  );

  // A lane over every node between its ends went up for nothing over a node standing wholly above it,
  // and came down again through whatever stood under that node.
  it('runs a wire that climbs at the lowest lane that clears what it runs over, under a node wholly above', () => {
    const looping = (sayAt: string) =>
      drawing(
        ['start:start@-300,200', 'loop:for@0,200', 'send:publish@400,200', 'end:end@100,400', `say:debug@${sayAt}`],
        'start.out>loop.in',
        'loop.body>send.in',
        'send.out>loop.next',
        'loop.done>end.in',
      );

    expect(routeOf(looping('200,180'), 'w3')!.lane).toBe(180 - 32);
    expect(routeOf(looping('200,40'), 'w3')!.lane).toBe(200 - 32);
  });

  it('rises past a node standing in its column, and comes down beside the way in', () => {
    const flow = left['MQTT in where the palette put it, under the End'];
    const route = routeOf(flow, 'w2')!;

    // The End stands over MQTT in's way out: the wire rises past the End's right edge, not through it.
    expect(route.rise).toBe(360 + drawnBox('end').width + MARGIN);
    expect(route.lane).toBe(120 - 32);
    expect(route.drop).toBe(drawnAs(flow).legs[1].target.x - MARGIN);
  });

  it('takes a wire down to a way in further left under the node it leaves, between the two rows', () => {
    const route = routeOf(left['a For’s done to an End straight under it'], 'w4')!;

    expect(route.rise).toBeNull();
    expect(route.lane).toBeGreaterThan(120 + drawnBox('for').height);
    expect(route.lane).toBeLessThan(300);
  });

  // The two returns nested as their loops are: the inner one under the outer one, so neither runs on
  // the other and neither crosses the other.
  it('stacks the returns of two loops one inside the other, the inner one lower, 16 apart', () => {
    const flow = left['two loops on one row, one inside the other'];
    const inner = routeOf(flow, 'w4')!;
    const outer = routeOf(flow, 'w6')!;

    expect(inner.lane).toBe(120 - 32);
    expect(outer.lane).toBe(inner.lane - 16);
    expect(outer.rise).toBeGreaterThanOrEqual(inner.rise! + 16);
  });

  // Each wire lights when a message goes down it: on one line with another, nobody could tell which.
  // Where they go into one next, they come down onto it together.
  it('runs each return into one next along a lane of its own, and brings them down onto it together', () => {
    const watch = exampleFlows()[1];
    const returns = watch.edges.filter((edge) => edge.toPort === 'next').map((edge) => routeOf(watch, edge.id)!);

    expect(new Set(returns.map((route) => route.lane)).size).toBe(returns.length);
    expect(new Set(returns.map((route) => route.drop)).size).toBe(1);
  });

  // The curve out of a foot turned back up while still beside its node, and ran through the node's
  // lower corner, or through the step that stood after it on the row.
  it('goes from a foot down, along under the row and up into a way in to its right', () => {
    const flow = clickedTogether['MQTT in, Debug and If clicked after the Start, then Publish on the If’s yes'];
    const no = flow.edges.find((edge) => edge.from === 'test' && edge.fromPort === 'no')!;
    const test = flow.nodes.find((node) => node.id === 'test')!;
    const route = routeOf(flow, no.id)!;

    expect(route.rise).toBeNull();
    expect(route.lane).toBe(test.y + drawnBox('if').height + MARGIN);
  });

  // Along under the whole row, the For's done passed between the If's foot and the short run of its
  // no back to the loop, and crossed that wire twice; under it, it crosses it nowhere.
  it('runs a wire going right under a row under what climbs out of the feet there', () => {
    const flow = clickedTogether['a For after the Start, MQTT in, Debug and If on its body, Publish on the If’s yes'];
    const done = routeOf(flow, wireOf(flow, 'loop', 'done'))!;
    const no = routedIn(flow).drawn.find(({ leg }) => leg.id === wireOf(flow, 'test', 'no'))!;

    expect(done.lane).toBeGreaterThanOrEqual(no.route.below! + 16);
    expect(Math.max(...pointsOf(no.leg.source, no.leg.target, no.route).map((point) => point.y))).toBeLessThan(done.lane);
  });

  it('draws nothing round a wire that goes forward', () => {
    const flow = clickedTogether['a new flow, the Start picked, MQTT in clicked'];
    const { nodes, legs } = drawnAs(flow);

    expect(routes(nodes, legs).size).toBe(0);
  });
});
