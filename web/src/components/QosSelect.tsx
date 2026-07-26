type Props = { name: string; value: number; onChange: (qos: number) => void };

// The labels carry no class of their own: they sit inside the panel's .checks row, which
// styles them, exactly as the markup in the previous console did.
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
