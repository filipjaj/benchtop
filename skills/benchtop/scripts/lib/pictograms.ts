// Hand-drawn pictograms for the pages of the guide that are the same in every build:
// tools, how to make a joint, what a good and a bad joint look like. Same two line
// weights as the scale drawings so the booklet reads as one hand.

const H = 1.1; // heavy
const T = 0.5; // thin
const stroke = (w: number) => `fill="#fff" stroke="#111" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const line = (w: number) => `fill="none" stroke="#111" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img">${body}</svg>`;

export const TOOLS: Record<string, { label: string; svg: string }> = {
  iron: {
    label: "Soldering iron",
    svg: svg(
      48,
      40,
      `<g transform="rotate(-32 24 20)"><rect x="3" y="15" width="20" height="10" rx="4" ${stroke(H)}/>` +
        `<path d="M8 15v10M12 15v10M16 15v10" ${line(T)}/><rect x="23" y="17.5" width="12" height="5" ${stroke(H)}/>` +
        `<path d="M35 18.2 L45 20 L35 21.8 Z" ${stroke(H)}/></g>`,
    ),
  },
  solder: {
    label: "Solder",
    svg: svg(
      48,
      40,
      `<path d="M10 12 v16 a10 4 0 0 0 20 0 v-16" ${stroke(H)}/><ellipse cx="20" cy="12" rx="10" ry="4" ${stroke(H)}/>` +
        `<ellipse cx="20" cy="12" rx="3.2" ry="1.3" ${stroke(T)}/><path d="M10 18 a10 4 0 0 0 20 0 M10 23 a10 4 0 0 0 20 0" ${line(T)}/>` +
        `<path d="M30 24 C38 24 36 10 44 12" ${line(H)}/>`,
    ),
  },
  cutters: {
    label: "Side cutters",
    svg: svg(
      48,
      40,
      `<path d="M24 18 C18 26 10 30 5 36 l4 2 C14 32 22 28 26 21 Z" ${stroke(H)}/>` +
        `<path d="M24 18 C30 26 38 30 43 36 l-4 2 C34 32 26 28 22 21 Z" ${stroke(H)}/>` +
        `<path d="M21 19 L17 4 l5 0 L24 15 L26 4 l5 0 L27 19 Z" ${stroke(H)}/><circle cx="24" cy="19" r="1.6" ${stroke(T)}/>`,
    ),
  },
  stripper: {
    label: "Wire stripper",
    svg: svg(
      48,
      40,
      `<path d="M6 30 h14 M28 30 h14" ${line(2.6)}/><path d="M20 30 h8" ${line(H)}/>` +
        `<path d="M20 22 v16 M28 22 v16" ${line(T)}/><path d="M20 10 l4 6 l4 -6" ${line(H)}/><path d="M24 4 v12" ${line(H)}/>`,
    ),
  },
  multimeter: {
    label: "Multimeter",
    svg: svg(
      48,
      40,
      `<rect x="12" y="3" width="20" height="34" rx="3" ${stroke(H)}/><rect x="15" y="7" width="14" height="8" ${stroke(T)}/>` +
        `<circle cx="22" cy="24" r="5.5" ${stroke(T)}/><path d="M22 24 l3 -4" ${line(H)}/>` +
        `<path d="M18 37 c0 6 -12 2 -12 -8 M26 37 c0 6 16 4 16 -10" ${line(T)}/>`,
    ),
  },
  screwdriver: {
    label: "Small screwdriver",
    svg: svg(
      48,
      40,
      `<g transform="rotate(-32 24 20)"><rect x="3" y="15.5" width="16" height="9" rx="4" ${stroke(H)}/>` +
        `<rect x="19" y="18.6" width="22" height="2.8" ${stroke(H)}/><path d="M41 18 l4 2 l-4 2 Z" ${stroke(H)}/></g>`,
    ),
  },
  usb: {
    label: "USB cable",
    svg: svg(
      48,
      40,
      `<rect x="4" y="13" width="16" height="14" rx="2" ${stroke(H)}/><rect x="20" y="16" width="8" height="8" ${stroke(H)}/>` +
        `<path d="M4 20 C-2 20 0 34 12 34 h30" ${line(H)}/><path d="M22.5 18.5 h3 M22.5 21.5 h3" ${line(T)}/>`,
    ),
  },
  printer: {
    label: "3D printer",
    svg: svg(
      48,
      40,
      `<path d="M6 36 V5 h36 v31" ${stroke(H)}/><path d="M3 36 h42" ${line(H)}/><path d="M6 12 h36" ${line(T)}/>` +
        `<rect x="20" y="10" width="8" height="7" ${stroke(H)}/><path d="M22.5 17 l1.5 3 l1.5 -3" ${line(T)}/>` +
        `<rect x="16" y="26" width="16" height="7" ${stroke(T)}/><path d="M10 33 h28" ${line(H)}/>`,
    ),
  },
};

const board = `<rect x="2" y="24" width="56" height="5" ${stroke(H)}/>`;
const pin = (x: number) => `<rect x="${x - 1.4}" y="6" width="2.8" height="30" ${stroke(T)}/>`;
const pad = (x: number) => `<path d="M${x - 8} 24 h16" ${line(1.8)}/>`;
const cross = `<path d="M6 4 L54 40 M54 4 L6 40" fill="none" stroke="#111" stroke-width="2.6" stroke-linecap="round"/>`;

/** Cross-sections through a solder joint: the pin passes up through the board. */
export const JOINTS = {
  good: svg(
    60,
    44,
    `${board}${pad(30)}<path d="M22.5 24 Q29 22 28.6 10 L31.4 10 Q31 22 37.5 24 Z" fill="#111"/>${pin(30)}`,
  ),
  cold: svg(
    60,
    44,
    `${board}${pad(30)}${pin(30)}<ellipse cx="30" cy="17.5" rx="6.5" ry="6" fill="#111"/>${cross}`,
  ),
  starved: svg(60, 44, `${board}${pad(30)}${pin(30)}<path d="M27.5 24 Q29 23 28.6 20 L31.4 20 Q31 23 32.5 24 Z" fill="#111"/>${cross}`),
  bridge: svg(
    60,
    44,
    `${board}${pad(20)}${pad(40)}${pin(20)}${pin(40)}<path d="M13 24 Q19 22 18.6 13 Q30 9 41.4 13 Q41 22 47 24 Z" fill="#111"/>${cross}`,
  ),
};

/** Three frames: heat pad and pin together, feed solder into the joint, lift solder then iron. */
export const JOINT_SEQUENCE = [
  svg(
    60,
    44,
    `${board}${pad(30)}${pin(30)}<path d="M54 6 L36 21 l-2.5 -0.5 l1 2.8 Z" ${stroke(H)}/>` +
      `<path d="M39 30 q2 2 0 4 M43 30 q2 2 0 4" ${line(T)}/>`,
  ),
  svg(
    60,
    44,
    `${board}${pad(30)}${pin(30)}<path d="M54 6 L36 21 l-2.5 -0.5 l1 2.8 Z" ${stroke(H)}/>` +
      `<path d="M4 8 L25 21" ${line(H)}/><path d="M24.5 24 Q28.5 23 28.6 18 L31.4 18 Q31.5 23 35.5 24 Z" fill="#111"/>`,
  ),
  svg(
    60,
    44,
    `${board}${pad(30)}<path d="M22.5 24 Q29 22 28.6 10 L31.4 10 Q31 22 37.5 24 Z" fill="#111"/>${pin(30)}` +
      `<path d="M50 4 l-7 7 M50 4 l-4.5 0.6 M50 4 l-0.6 4.5" ${line(H)}/>`,
  ),
];

/** A wire end: stripped 3 mm, twisted, tinned. */
export const WIRE_PREP = svg(
  120,
  30,
  `<path d="M4 9 h26" ${line(4.2)}/><path d="M30 9 h9" ${line(T * 2.4)}/><path d="M30 14 v5 M39 14 v5 M30 16.5 h9" ${line(T)}/>` +
    `<text x="34.5" y="26" text-anchor="middle" font-family="Noto Sans, Helvetica, Arial, sans-serif" font-size="5.4" font-weight="700">3 mm</text>` +
    `<path d="M52 9 h26" ${line(4.2)}/><path d="M78 9 h9" ${line(T * 2.4)}/><path d="M80 7.6 l1.6 2.8 M83 7.6 l1.6 2.8" ${line(T)}/>` +
    `<path d="M82 17 a4 4 0 1 1 4 -1.5 M86 15.5 l0.6 -2.6 M86 15.5 l-2.6 0.2" ${line(T)}/>` +
    `<path d="M98 9 h14" ${line(4.2)}/><path d="M112 9 h7" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round"/>`,
);

export const WARNING = svg(
  30,
  28,
  `<path d="M15 3 L28 25 H2 Z" ${stroke(H * 1.4)}/><path d="M15 10 v8" ${line(2.2)}/><circle cx="15" cy="21.5" r="1.4" fill="#111"/>`,
);
