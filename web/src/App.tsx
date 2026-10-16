import { useEffect, useState } from 'react';
import { getStored, setStored, wake } from './api.js';
import Home from './Home.js';
import Room from './Room.js';
import { useTheme } from './theme.js';

const fromUrl = (): string | null => (new URLSearchParams(location.search).get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [roomId, setRoomId] = useState<string | null>(fromUrl);
  const [name, setName] = useState(() => getStored('name') || '');
  const [invite, setInvite] = useState<string | null>(fromUrl);

  useEffect(() => {
    wake();
    const onPop = () => setRoomId(fromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (id: string | null) => {
    history.pushState({}, '', id ? `/?r=${id}` : '/');
    setRoomId(id);
    if (!id) setInvite(null);
  };
  const saveName = (n: string) => {
    setStored('name', n);
    setName(n);
  };

  // Returning visitors with a name go straight in; first timers pick a name first.
  if (roomId && name) return <Room key={roomId} roomId={roomId} name={name} theme={theme} onTheme={toggleTheme} onLeave={() => go(null)} onRename={saveName} />;
  return <Home inviteId={invite && !name ? invite : null} name={name} theme={theme} onTheme={toggleTheme} onName={saveName} onEnter={go} />;
}
