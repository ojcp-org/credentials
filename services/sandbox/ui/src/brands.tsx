/**
 * The sandbox's made-up companies, each with a look of its own so it's always
 * clear whose site you're on. WorkSecond winks at Workday, MDP (Manual Data
 * Processing) at ADP, and BlueHouse at Greenhouse; Acme is the cartoon
 * classic, Vandelay the Seinfeld one. None is a real company.
 */

export const WORKSECOND = {
  name: "WorkSecond",
  /** Workday's blue and orange, more or less. */
  navy: "#0b2a5b",
  blue: "#1f5fbf",
  orange: "#f5a623",
  tint: "#f3f6fb",
};

export const MDP = {
  name: "MDP",
  /** ADP's red, more or less. */
  red: "#c8102e",
  ink: "#2b2b2b",
  tint: "#fbf4f5",
};

export const VANDELAY = {
  name: "Vandelay Industries",
  green: "#1f6f5c",
  deep: "#123f35",
  tint: "#f2f7f5",
};

export const ACME = {
  name: "Acme Corporation",
  red: "#d6331f",
  ink: "#1d1d1f",
  cream: "#fff8ec",
};

export const BLUEHOUSE = {
  name: "BlueHouse",
  blue: "#1d6ff2",
  deep: "#0f3a85",
  tint: "#f2f6ff",
};

/** "mdp" in a red lozenge, with a crank handle for the M. */
export function MdpMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size * 1.6} height={size} viewBox="0 0 48 30" aria-hidden="true">
      <rect width="48" height="30" rx="15" fill="#fff" />
      <text
        x="24"
        y="20.5"
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontStyle="italic"
        fontWeight="700"
        fontSize="17"
        fill={MDP.red}
      >
        mdp
      </text>
    </svg>
  );
}

/** A "V" over a crate: importer, exporter. */
export function VandelayMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#fff" />
      <rect x="5" y="17" width="22" height="10" rx="1.5" fill={VANDELAY.green} />
      <path d="M8 5l8 11 8-11" fill="none" stroke={VANDELAY.green} strokeWidth="3.2" />
    </svg>
  );
}

/** A "w" under a rising half-second arc. */
export function WorkSecondMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#fff" />
      <path
        d="M7 13a9 9 0 0 1 18 0"
        fill="none"
        stroke={WORKSECOND.orange}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M8 16l3 8 3-6 2 0 3 6 3-8"
        fill="none"
        stroke={WORKSECOND.blue}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The anvil, in Acme red. */
export function AcmeMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill={ACME.red} />
      <path
        d="M6 11h17c0 3 2 4 4 4v2c-3 0-5 0-6 1l-1 2h3v3H9v-3h3l-1-2c-2-1-4-3-5-7z"
        fill="#fff"
      />
    </svg>
  );
}

export function AcmeWordmark() {
  return (
    <span
      style={{
        fontFamily: "Impact, 'Arial Black', sans-serif",
        fontSize: 22,
        letterSpacing: 1.5,
        color: ACME.ink,
        lineHeight: 1,
      }}
    >
      ACME<span style={{ color: ACME.red }}>.</span>
    </span>
  );
}

/** A house with a door, in BlueHouse blue. */
export function BlueHouseMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill={BLUEHOUSE.blue} />
      <path d="M16 6 5 15h3v11h16V15h3z" fill="#fff" />
      <rect x="14" y="18" width="4" height="8" rx="1" fill={BLUEHOUSE.blue} />
    </svg>
  );
}
