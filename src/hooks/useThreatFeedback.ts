import { useEffect } from 'react';
import type { PlayerState } from '../lib/types';

const beep = (durationMs: number): void => {
  const AudioContextImpl = window.AudioContext;
  if (!AudioContextImpl) return;

  const ctx = new AudioContextImpl();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = 880;
  gain.gain.value = 0.05;
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();

  setTimeout(() => {
    oscillator.stop();
    void ctx.close();
  }, durationMs);
};

export const useThreatFeedback = (state: PlayerState): boolean => {
  useEffect(() => {
    if (state === 'CAUGHT') {
      beep(1500);
      navigator.vibrate?.([1200]);
      return;
    }

    if (state === 'WARNING' || state === 'DANGER') {
      const interval = state === 'DANGER' ? 350 : 1200;
      const id = window.setInterval(() => {
        beep(state === 'DANGER' ? 120 : 80);
        navigator.vibrate?.(state === 'DANGER' ? [90] : [50]);
      }, interval);
      return () => window.clearInterval(id);
    }

    navigator.vibrate?.(0);
    return;
  }, [state]);

  return state === 'DANGER';
};
