type Props = { name: string; value: number; onChange: (qos: number) => void };

// Labels are unstyled; the panel's .checks row styles them.
export function QosSelect({ name, value, onChange }: Props) {
  return (
    <>
      {[0, 1, 2].map((level) => (
        <label key={level}>
          <input
            type="radio"
            name={name}
            value={level}
            checked={value === level}
            onChange={() => onChange(level)}
          />
          {` QoS ${level}`}
        </label>
      ))}
    </>
  );
}
