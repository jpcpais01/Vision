/**
 * Tiny synthesized jingles for the win-animation overlays — oscillators, not
 * shipped audio files. Browsers block audio until a real user gesture has
 * happened in the tab, so `primeSound()` must be called from inside one (the
 * Start button click) to create/resume the shared context; every later,
 * automatically-triggered `playWinSound()` then just plays through it.
 */

export type WinTier = 'big' | 'great' | 'amazing';

let ctx: AudioContext | null = null;

export function primeSound(): void {
  if (typeof window === 'undefined') return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === 'suspended') void ctx.resume();
}

function tone(freq: number, startOffset: number, duration: number, peak: number): void {
  if (!ctx) return;
  const t0 = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

/** An ascending arpeggio, one note per tier reached — bigger win, more notes, brighter peak. */
export function playWinSound(tier: WinTier): void {
  if (!ctx) return; // never primed this session (no Start click yet) — stay silent, not an error
  if (tier === 'big') {
    tone(659, 0, 0.16, 0.15); // E5
  } else if (tier === 'great') {
    tone(659, 0, 0.14, 0.15); // E5
    tone(880, 0.11, 0.2, 0.18); // A5
  } else {
    tone(659, 0, 0.12, 0.15); // E5
    tone(880, 0.1, 0.14, 0.17); // A5
    tone(1175, 0.2, 0.3, 0.22); // D6
  }
}
