// Keycaps: <Keys keys="Ctrl Option G" />
export function Keys({ keys }) {
  return (
    <span className="keys">
      {keys.split(' ').map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}
