export function PlaceFingerButton({
  busy,
  ready,
  disabled,
  label,
  onClick,
}: {
  busy: boolean;
  ready: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`pay-btn ${busy ? "paying" : ""} ${ready ? "ready" : "not-ready"}`}
      disabled={disabled}
      aria-busy={busy}
      onClick={onClick}
    >
      <svg className="pay-print" viewBox="0 0 24 24" aria-hidden focusable="false">
        <path d="M12 3a8 8 0 0 0-8 8v2" />
        <path d="M20 13v-2a8 8 0 0 0-3-6.2" />
        <path d="M8 21a10 10 0 0 0 1-5v-4a3 3 0 0 1 6 0v1" />
        <path d="M12 12v4a13 13 0 0 1-1.5 6" />
        <path d="M15 16a17 17 0 0 1-.6 4.5" />
        <path d="M18 17.5a20 20 0 0 0 .3-3.5" />
        <path d="M5.5 17a6 6 0 0 0 .5-2.5V11a6 6 0 0 1 9.6-4.8" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
