// GOAT's logo: a kopitiam cup of kopi, outlined in black with a hard shadow (as in the app icon).
export function CupLogo({ className }) {
  return (
    <svg className={className} viewBox="6.5 6 51 47.5" aria-hidden="true">
      <g strokeLinejoin="round" strokeLinecap="round">
        <g transform="translate(2.4 2.4)" fill="#0a0a0a" stroke="#0a0a0a" strokeWidth="2.4">
          <ellipse cx="30" cy="45.5" rx="22" ry="5" />
          <path d="M14 21 L17.5 40 Q18.5 44 23 44 L37 44 Q41.5 44 42.5 40 L46 21 Z" />
          <path d="M44.6 25.5 C53 24.5 54.5 36.5 43.4 35.8" fill="none" strokeWidth="5" />
        </g>
        <ellipse cx="30" cy="45.5" rx="22" ry="5" fill="#ffffff" stroke="#0a0a0a" strokeWidth="2.4" />
        <path d="M44.6 25.5 C53 24.5 54.5 36.5 43.4 35.8" fill="none" stroke="#0a0a0a" strokeWidth="6.6" />
        <path d="M44.6 25.5 C53 24.5 54.5 36.5 43.4 35.8" fill="none" stroke="#ffffff" strokeWidth="2.6" />
        <path d="M14 21 L17.5 40 Q18.5 44 23 44 L37 44 Q41.5 44 42.5 40 L46 21 Z" fill="#ffffff" />
        <path d="M15.9 25.4 L44.1 25.4 L43.55 28.6 L16.45 28.6 Z" fill="#1f7a4d" />
        <path d="M14 21 L17.5 40 Q18.5 44 23 44 L37 44 Q41.5 44 42.5 40 L46 21 Z" fill="none" stroke="#0a0a0a" strokeWidth="2.4" />
        <ellipse cx="30" cy="21" rx="16" ry="3.6" fill="#ffffff" stroke="#0a0a0a" strokeWidth="2.4" />
        <ellipse cx="30" cy="21.3" rx="13.1" ry="2.3" fill="#6b3f1d" />
        <path d="M25 15.5 c-2.6 -2.6 2.6 -4.6 0 -7.6 M33.5 15.5 c-2.6 -2.6 2.6 -4.6 0 -7.6" fill="none" stroke="#0a0a0a" strokeWidth="2.4" />
      </g>
    </svg>
  );
}
