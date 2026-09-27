import type { FlowNodeType } from '../../types/api';
import { DRAG_TYPE } from './FlowCanvas';
import { GROUPS, NODE_SPECS } from './nodeTypes';
import styles from './Palette.module.css';

/**
 * Every node there is, under the three questions a flow answers: what starts it, what it decides,
 * what it does. Each item can be dragged onto the canvas, and clicked — a click adds the node in
 * the middle of the view, which is the way in for a keyboard and for a trackpad that drags badly.
 */
export function Palette({ onAdd }: { onAdd: (type: FlowNodeType) => void }) {
  return (
    <nav className={styles.palette} aria-label="Nodes">
      {GROUPS.map((group) => (
        <section key={group} className={styles.group}>
          <h3 className={styles.heading}>{group}</h3>

          {Object.values(NODE_SPECS)
            .filter((spec) => spec.group === group)
            .map((spec) => {
              const Icon = spec.icon;

              return (
                <button
                  key={spec.type}
                  type="button"
                  className={`ghost ${styles.item}`}
                  data-group={group}
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
    </nav>
  );
}
