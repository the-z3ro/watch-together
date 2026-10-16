import { useCallback, useEffect, useState } from 'react';
import { getStored, setStored } from './api.js';

export type Theme = 'dark' | 'light';

const initial = (): Theme => {
  const s = getStored('theme');
  if (s === 'dark' || s === 'light') return s;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#0b0b0e' : '#f6f4ef');
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const n = t === 'dark' ? 'light' : 'dark';
      setStored('theme', n);
      return n;
    });
  }, []);
  return [theme, toggle];
}
