import { Link, Outlet } from '@tanstack/react-router';
import {
  Activity, Bot, FlaskConical, GitCompareArrows, Home, Layers, Moon, Palette, Server, Sparkles, Sun, Trophy, Waypoints,
} from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import { useLiveStatus } from '../lib/live';
import { robotTone, useRobots, useSelectedRobot } from '../lib/robots';
import { cn } from '../lib/utils';
import { AgentPanel } from './agent/AgentPanel';
import { FeedbackHost } from './feedback';
import { Badge } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/runs', label: 'Runs', icon: Activity },
  { to: '/compare', label: 'Compare', icon: GitCompareArrows },
  { to: '/models', label: 'Models', icon: Trophy },
  { to: '/curricula', label: 'Curricula', icon: Waypoints },
  { to: '/design', label: 'Design', icon: Palette },
  { to: '/insights', label: 'Insights', icon: Layers },
  { to: '/lab', label: 'Lab', icon: FlaskConical },
  { to: '/system', label: 'System', icon: Server },
];

function RobotSwitcher() {
  const { data: robots } = useRobots();
  const [robot, setRobot] = useSelectedRobot();
  const options = [{ id: '', label: 'All robots' }, ...(robots ?? []).map((r) => ({ id: r.id, label: r.display_name }))];
  return (
    <div className="px-2 lg:px-3">
      <p className="mb-1.5 hidden px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:block">Robot</p>
      <div className="flex flex-col gap-0.5">
        {options.map((o) => {
          const active = o.id === robot;
          const info = robots?.find((r) => r.id === o.id);
          return (
            <button
              key={o.id || 'all'}
              onClick={() => setRobot(o.id)}
              title={o.label}
              className={cn(
                'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
                active ? 'bg-card font-medium shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {o.id ? (
                <Badge tone={robotTone(info)} className="h-5 w-5 justify-center p-0">
                  <Bot className="h-3 w-3" />
                </Badge>
              ) : (
                <span className="grid h-5 w-5 place-items-center rounded-full bg-muted text-[10px] font-semibold">∗</span>
              )}
              <span className="hidden truncate lg:inline">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LiveIndicator() {
  const status = useLiveStatus();
  const label = { live: 'Live', connecting: 'Connecting…', offline: 'Offline, retrying' }[status];
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`${label}: live updates from the dashboard server`}>
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          status === 'live' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-rose-500',
        )}
      />
      <span className="hidden lg:inline">{label}</span>
    </span>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
    setDark(next);
  };
  return (
    <button
      onClick={toggle}
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      title={dark ? 'Light theme' : 'Dark theme'}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function useAgentOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem('agentOpen') === '1');
  const set = (v: boolean) => {
    localStorage.setItem('agentOpen', v ? '1' : '0');
    setOpen(v);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setOpen((o) => {
          localStorage.setItem('agentOpen', o ? '0' : '1');
          return !o;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [open, set];
}

export function AppShell() {
  const [agentOpen, setAgentOpen] = useAgentOpen();
  // Stays mounted once opened, so closing the panel doesn't cut off a reply.
  const [agentMounted, setAgentMounted] = useState(agentOpen);
  useEffect(() => {
    if (agentOpen) setAgentMounted(true);
  }, [agentOpen]);
  return (
    <div className="flex h-full">
      <aside className="flex w-14 shrink-0 flex-col gap-5 overflow-y-auto border-r bg-sidebar py-4 lg:w-60">
        <div className="flex items-center gap-2 px-3.5 lg:px-5">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Bot className="h-4 w-4" />
          </div>
          <div className="hidden leading-tight lg:block">
            <p className="text-sm font-semibold">Robot Lab</p>
            <p className="text-[11px] text-muted-foreground">Training & evaluation</p>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2 lg:px-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              title={label}
              activeOptions={{ exact: to === '/' }}
              className="flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              activeProps={{ className: 'bg-muted !text-foreground font-medium' }}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden flex-1 lg:inline">{label}</span>
            </Link>
          ))}
        </nav>
        <RobotSwitcher />
        <div className="mt-auto flex flex-col gap-3 px-2 lg:px-3">
          <button
            onClick={() => setAgentOpen(!agentOpen)}
            title="Assistant (Ctrl+/)"
            className={cn(
              'flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm transition-colors',
              agentOpen ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Sparkles className="h-4 w-4 shrink-0" />
            <span className="hidden flex-1 text-left lg:inline">Assistant</span>
            <kbd className="hidden rounded border px-1 font-mono text-[10px] text-muted-foreground lg:inline">Ctrl /</kbd>
          </button>
          <div className="flex flex-col items-center gap-2 lg:flex-row lg:justify-between lg:px-2">
            <LiveIndicator />
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      {agentMounted && <AgentPanel hidden={!agentOpen} onClose={() => setAgentOpen(false)} />}
      <FeedbackHost />
    </div>
  );
}
