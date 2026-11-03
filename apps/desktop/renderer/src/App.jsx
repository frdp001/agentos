import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import ChatConsole from './views/ChatConsole.jsx';
import CampaignDashboard from './views/CampaignDashboard.jsx';
import TemplateEditor from './views/TemplateEditor.jsx';
import TriageInbox from './views/TriageInbox.jsx';
import MemoryVault from './views/MemoryVault.jsx';
import Settings from './views/Settings.jsx';
import { api } from './lib/api.js';

const VIEWS = {
  chat: ChatConsole,
  campaigns: CampaignDashboard,
  templates: TemplateEditor,
  inbox: TriageInbox,
  memory: MemoryVault,
  settings: Settings,
};

export default function App() {
  const [view, setView] = useState('campaigns');
  const [health, setHealth] = useState({ online: false, checking: true });

  useEffect(() => {
    let timer;
    const poll = async () => {
      const result = await api.daemonHealth();
      setHealth({ ...result, checking: false });
      timer = setTimeout(poll, 5000);
    };
    poll();
    return () => clearTimeout(timer);
  }, []);

  const View = VIEWS[view] ?? CampaignDashboard;

  return (
    <div className="flex h-full w-full bg-base-950">
      <Sidebar view={view} onNavigate={setView} health={health} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar view={view} health={health} />
        <main className="min-h-0 flex-1 overflow-auto p-6">
          <View />
        </main>
      </div>
    </div>
  );
}
