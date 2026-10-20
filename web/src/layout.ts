// Pure layout decisions. Everything about "what fits" is computed here from numbers, so it can be unit-tested
// instead of hoped-for in CSS.

export type LayoutMode = 'wide' | 'stack' | 'landscape';

/**
 * wide:      room beside the player (laptops, big tablets in landscape)
 * landscape: short + wide window (phones turned sideways): player takes the full height, the room panel is a drawer
 * stack:     everything else (phones/tablets in portrait, narrow windows): player on top, panel below
 */
export function layoutMode(w: number, h: number): LayoutMode {
  if (h < 520 && w > h) return 'landscape';
  if (w >= 1000) return 'wide';
  return 'stack';
}

export type SizeClass = 'xs' | 'sm' | 'md' | 'lg';
export function sizeClass(playerWidth: number): SizeClass {
  return playerWidth < 380 ? 'xs' : playerWidth < 560 ? 'sm' : playerWidth < 860 ? 'md' : 'lg';
}

export type CtrlId = 'back' | 'play' | 'fwd' | 'time' | 'status' | 'rate' | 'sync' | 'cc' | 'mute' | 'volume' | 'pip' | 'settings' | 'full';

export interface ControlPlan {
  inline: ReadonlySet<CtrlId>;
}

export interface PlanInput {
  /** Width of the player box in CSS px. */
  width: number;
  touch: boolean;
  /** Touch layout puts back/play/forward in a big centre cluster, so the bottom row doesn't need them. */
  centerCluster?: boolean;
  /** Characters in the time label, e.g. "1:23:45 / 2:00:00" = 17. */
  timeChars: number;
  /** Which optional controls make sense right now (captions loaded? PiP supported? …). */
  has: Partial<Record<CtrlId, boolean>>;
}

export const CONTROL_PAD = 16; // 8px each side
const SAFETY = 8;

export function controlWidth(id: CtrlId, touch: boolean, timeChars: number): number {
  const btn = touch ? 44 : 40;
  switch (id) {
    case 'play':
      return touch ? 52 : 46;
    case 'time':
      return Math.ceil(timeChars * 6.9) + 14;
    case 'status':
      return 112;
    case 'rate':
      return touch ? 48 : 46;
    case 'volume':
      return 78;
    default:
      return btn;
  }
}

/** Mandatory controls always stay; the rest are added in priority order until one no longer fits. */
const MANDATORY: CtrlId[] = ['play', 'settings', 'full'];
const MANDATORY_CLUSTER: CtrlId[] = ['settings', 'full'];
const OPTIONAL_BY_PRIORITY: CtrlId[] = ['sync', 'mute', 'cc', 'time', 'rate', 'back', 'fwd', 'pip', 'volume', 'status'];

export function planControls(i: PlanInput): ControlPlan {
  const avail = i.width - CONTROL_PAD - SAFETY;
  const mandatory = i.centerCluster ? MANDATORY_CLUSTER : MANDATORY;
  const inline = new Set<CtrlId>(mandatory);
  let used = mandatory.reduce((s, id) => s + controlWidth(id, i.touch, i.timeChars), 0);
  for (const id of OPTIONAL_BY_PRIORITY) {
    if (i.has[id] === false) continue;
    if (i.centerCluster && (id === 'back' || id === 'fwd')) continue;
    if (id === 'volume' && (i.touch || !inline.has('mute'))) continue; // the slider is a mouse nicety and needs its mute button
    const w = controlWidth(id, i.touch, i.timeChars);
    if (used + w > avail) break; // prefix of the priority list: the set only ever grows with width, so buttons never flip-flop
    inline.add(id);
    used += w;
  }
  return { inline };
}
