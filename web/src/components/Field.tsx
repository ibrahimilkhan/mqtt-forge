import { useId, useState, type ReactNode } from 'react';
import { InfoBody, InfoMark } from './InfoTip';
import styles from '../styles/panel.module.css';

type Props = {
  label: string;
  htmlFor: string;
  narrow?: boolean;
  /**
   * Marks that belong to the field rather than to the form: a button that opens a picker for this
   * box. They ride at the end of the label's own line, which is the only place in a stacked field
   * where something can stand beside the label without being mistaken for a second label or for
   * the value.
   */
  aside?: ReactNode;
  /**
   * What this box wants, at length, behind a mark of its own.
   *
   * Given here rather than composed by the caller, because where the paragraph lands is the whole
   * difficulty: the mark has to be on the label's line and the paragraph has to be out of it. A
   * caller putting both into `aside` gets the explanation laid out as a flex item beside the
   * label, which is a column of two words wide and thirty lines tall.
   */
  help?: ReactNode;
  children: ReactNode;
};

/**
 * One labelled control, with the same rhythm as every other one on the page.
 *
 * The head is a row rather than a bare `<label>` so the label can be given company, and it
 * carries the gap down to the box: that gap is stated in one place, which is what keeps a label
 * closer to its own box than to the box above it. A form where the two distances are the same
 * reads as a column of unattached words and boxes, which is exactly what this one did.
 *
 * The help opens under the control rather than over it. The reader's eye goes label, box, and
 * then — having seen what is being asked for — the paragraph about it; put between the label and
 * the box it would push the two apart, which is the one thing this component exists to prevent.
 */
export function Field({ label, htmlFor, narrow = false, aside, help, children }: Props) {
  const [open, setOpen] = useState(false);
  const helpId = useId();

  return (
    <div className={narrow ? `${styles.field} ${styles.narrow}` : styles.field}>
      <div className={styles.fieldHead}>
        <label htmlFor={htmlFor}>{label}</label>
        {aside}
        {help && (
          <InfoMark
            label={label}
            open={open}
            controls={helpId}
            onToggle={() => setOpen((shown) => !shown)}
          />
        )}
      </div>

      {children}

      {open && help && <InfoBody id={helpId}>{help}</InfoBody>}
    </div>
  );
}
