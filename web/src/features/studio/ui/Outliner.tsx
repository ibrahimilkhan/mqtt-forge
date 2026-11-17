import { useState } from 'react';
import { studioStore, useStudio } from '../studioStore';
import styles from './Outliner.module.css';

/**
 * Every object in the scene, by name. Children are indented under their parent; the link itself is
 * read-only until assemblies arrive, but a DesignBox scene's structure is still visible.
 */
export function Outliner() {
  const objects = useStudio((s) => s.scene?.objects ?? []);
  const selection = useStudio((s) => s.selection);
  const [look, setLook] = useState('');
  const { select, updateObject } = studioStore.getState();

  const needle = look.trim().toLowerCase();
  const shown = needle ? objects.filter((o) => o.name.toLowerCase().includes(needle)) : objects;
  const depth = (parentId: string | undefined, seen = new Set<string>()): number => {
    if (!parentId || seen.has(parentId)) return 0;
    seen.add(parentId);
    return 1 + depth(objects.find((o) => o.id === parentId)?.parentId, seen);
  };

  return (
    <nav className={styles.outliner} aria-label="Objects">
      <input
        type="search"
        className={styles.search}
        aria-label="Find an object"
        placeholder="Find…"
        value={look}
        onChange={(event) => setLook(event.target.value)}
      />
      {objects.length === 0 ? (
        <p className={styles.empty}>Nothing here yet. Add a shape from the toolbar.</p>
      ) : (
        <ul className={styles.list}>
          {shown.map((object) => (
            <li
              key={object.id}
              className={styles.row}
              data-selected={selection.includes(object.id)}
              data-hidden={object.hidden ?? false}
              style={{ paddingLeft: `${depth(object.parentId) * 14}px` }}
            >
              <button type="button" className={styles.name} onClick={() => select([object.id])}>
                {object.name}
              </button>
              <button
                type="button"
                className={styles.eye}
                aria-label={`${object.hidden ? 'Show' : 'Hide'} ${object.name}`}
                onClick={() => updateObject(object.id, { hidden: !object.hidden })}
              >
                {object.hidden ? 'Show' : 'Hide'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
