import type { FlowNodeType } from '../../types/api';
import { DRAG_TYPE } from './FlowCanvas';
import { GROUPS, NODE_SPECS } from './nodeTypes';
import styles from './Palette.module.css';

/**
 * Every node a reader can put down, under the four headings a flow is read by: what it takes in,
 * how it goes, what it does, and the alarm with what is told of it — Input, Control, Actions and
 * Alarm, each in the colour its nodes wear on the canvas. Not the Start: a flow has the one it was
 * made with. Each item says what its node does when it is pointed at, in the words its pane opens
 * with.
 *
 * An item can be dragged onto the canvas, where it lands where it is let go, or clicked — the way in
 * for a keyboard, and for a trackpad that drags badly. A click puts the node where the program needs
 * it: on the wire picked, after the node picked when that has one way out, or else in the middle of
 * the view (see the page's add). The node it puts down is picked in turn, so a chain is built by
 * clicking one item after another.
 *
 * A named group rather than a landmark: every item in it adds something, and none of them goes
 * anywhere, so it has no place among the page's ways around.
 */
export function Palette({ onAdd }: { onAdd: (type: FlowNodeType) => void }) {
  return (
    <div className={styles.palette} role="group" aria-label="Nodes">
      {GROUPS.map((group) => (
        <section key={group} className={styles.group}>
          <h3 className={styles.heading}>{group}</h3>

          {Object.values(NODE_SPECS)
            .filter((spec) => spec.group === group && spec.placeable)
            .map((spec) => {
              const Icon = spec.icon;

              return (
                <button
                  key={spec.type}
                  type="button"
                  className={`ghost ${styles.item}`}
                  data-group={group}
                  title={spec.help}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(DRAG_TYPE, spec.type);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => onAdd(spec.type)}
                >
                  <span className={styles.icon} aria-hidden="true">
                    <Icon />
                  </span>
                  <span className={styles.label}>{spec.label}</span>
                  <span className={styles.blurb}>{spec.blurb}</span>
                </button>
              );
            })}
        </section>
      ))}
    </div>
  );
}
